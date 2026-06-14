import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bull';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { MinioService } from '../storage/minio.service';
import { MistralOcrService } from '../ocr/mistral-ocr.service';
import { AutoClassifierService } from '../documents/auto-classifier.service';
import { ChunkingService } from '../chat/agent/chunking.service';
import { EmbeddingService } from '../chat/agent/embedding.service';
import { QdrantService } from '../../database/qdrant.service';
import { PostgresService } from '../../database/postgres.service';
import { AgentDocsClient } from '../agent-docs/agent-docs.client';
import { JUDGMENT_PROMPT_VERSION } from '../admin/judgment-analysis/prompts';
import { CHAT_UPLOAD_INBOX_CASE } from '../chat-uploads/chat-uploads.constants';

const PAGE_DPI = 150;

@Processor('document-processing')
export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);
  private openai: OpenAI;

  constructor(
    private minioService: MinioService,
    private ocrService: MistralOcrService,
    private classifierService: AutoClassifierService,
    private chunkingService: ChunkingService,
    private embeddingService: EmbeddingService,
    private qdrantService: QdrantService,
    private postgresService: PostgresService,
    private agentDocsClient: AgentDocsClient,
    private configService: ConfigService,
    @InjectQueue('judgment-analysis') private judgmentQueue: Queue,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
  }

  @Process('process-document')
  async processDocument(job: Job<any>): Promise<void> {
    const { documentId, bucket, key, ownerType, ownerId, reindex } = job.data;

    // User-uploaded documents follow a separate, isolated pipeline:
    // Mistral OCR + page render for the viewer, then chunk + FastEmbed in the
    // agent (per-owner/per-case Qdrant). No GPT-4o auto-classify, no shared
    // corpus tables, no admin review.
    if (ownerType === 'user' && !reindex) {
      await this.processUserDocument(job);
      return;
    }

    try {
      // 1. Fetch PDF from MinIO
      this.logger.log(`Processing document: ${documentId}`);
      const pdfBuffer = await this.minioService.downloadFile(bucket, key);
      await job.progress(5);

      // 1b. Render PDF pages to images (per-document bucket = documentId).
      // Persisted before OCR so pages remain visible even if later steps fail.
      try {
        await this.renderAndUploadPages(documentId, pdfBuffer);
        await job.progress(15);
      } catch (pageErr: any) {
        this.logger.error(
          `Page rendering failed for ${documentId}: ${pageErr?.message || pageErr}`,
        );
        await this.postgresService.query(
          `UPDATE documents SET pages_status = 'failed' WHERE id = $1`,
          [documentId],
        );
        // Don't throw — page render failure shouldn't block OCR.
      }

      // 2. OCR
      this.logger.log(`Running OCR for: ${documentId}`);
      const ocrText = await this.ocrService.processPdf(pdfBuffer);
      await job.progress(40);

      // 3. Save OCR output to MinIO
      const ocrKey = `${documentId}/ocr.md`;
      await this.minioService.uploadFile(
        'ocr-output',
        ocrKey,
        Buffer.from(ocrText, 'utf-8'),
        Buffer.byteLength(ocrText, 'utf-8'),
        'text/markdown',
      );

      // 4. Auto-classify
      const classification = await this.classifierService.classify(ocrText, this.openai);
      const collection = classification.collection;
      this.logger.log(`Document ${documentId} classified as: ${collection}`);
      await job.progress(60);

      // 5. Chunk text
      const chunks = this.chunkingService.chunkDocument(ocrText, collection);
      await job.progress(70);

      // 6. Embed chunks
      const chunkTexts = chunks.map((c) => c.content);
      const embeddings = await this.embeddingService.embedBatch(chunkTexts);
      await job.progress(85);

      // 7. Insert chunks to PostgreSQL
      const visibility = ownerType === 'system' ? 'public' : 'private';

      await this.postgresService.transaction(async (client) => {
        // Delete existing chunks if reindex
        if (reindex) {
          await client.query(
            `DELETE FROM document_chunks WHERE document_id = $1`,
            [documentId],
          );
        }

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          await client.query(
            `INSERT INTO document_chunks
               (id, document_id, chunk_index, content, article_ref, collection)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [
              uuidv4(),
              documentId,
              chunk.chunkIndex,
              chunk.content,
              chunk.articleRef || null,
              collection,
            ],
          );
        }

        // Update document metadata
        await client.query(
          `UPDATE documents SET
             collection = $1,
             ocr_text = $2,
             jurisdiction = $3,
             word_count = $4
           WHERE id = $5`,
          [
            collection,
            ocrText.slice(0, 10000), // store first 10k chars
            JSON.stringify(classification.jurisdiction),
            ocrText.split(/\s+/).length,
            documentId,
          ],
        );
      });

      // 8. Upsert vectors to Qdrant
      const points = chunks.map((chunk, i) => ({
        id: uuidv4().replace(/-/g, '').slice(0, 32),
        vector: embeddings[i],
        payload: {
          document_id: documentId,
          owner_id: ownerId || null,
          visibility,
          collection,
          content: chunk.content,
          article_ref: chunk.articleRef || null,
          chunk_index: chunk.chunkIndex,
        },
      }));

      // Qdrant requires numeric or UUID IDs — use hash of documentId + chunkIndex
      const qdrantPoints = points.map((p, i) => ({
        id: this.generateQdrantId(documentId, i),
        vector: embeddings[i],
        payload: p.payload,
      }));

      await this.qdrantService.upsert(collection, qdrantPoints);

      // 9. Update document status
      const newStatus = ownerType === 'system' ? 'published' : 'pending_review';
      await this.postgresService.query(
        `UPDATE documents SET status = $1 WHERE id = $2`,
        [newStatus, documentId],
      );

      await job.progress(100);
      this.logger.log(`Document ${documentId} processed successfully`);
    } catch (err) {
      this.logger.error(`Document processing failed for ${documentId}: ${err.message}`, err.stack);
      await this.postgresService.query(
        `UPDATE documents SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, documentId],
      );
      throw err;
    }
  }

  /**
   * Pipeline for a user-uploaded (case) document. Keeps OCR + page rendering
   * but delegates chunking/embedding/indexing to the lexia-agent (FastEmbed +
   * per-owner/per-case Qdrant). Sets status `ready` on success, `failed`
   * otherwise.
   */
  private async processUserDocument(job: Job<any>): Promise<void> {
    const { documentId, bucket, key, ownerId, caseId, documentType } = job.data;

    try {
      this.logger.log(`Processing user document: ${documentId}`);
      const pdfBuffer = await this.minioService.downloadFile(bucket, key);
      await job.progress(5);

      // Page images for the viewer (best-effort — do not block indexing).
      try {
        await this.renderAndUploadPages(documentId, pdfBuffer);
        await job.progress(20);
      } catch (pageErr: any) {
        this.logger.error(
          `Page rendering failed for ${documentId}: ${pageErr?.message || pageErr}`,
        );
        await this.postgresService.query(
          `UPDATE documents SET pages_status = 'failed' WHERE id = $1`,
          [documentId],
        );
      }

      // OCR via Mistral.
      this.logger.log(`Running OCR for user document: ${documentId}`);
      const ocrText = await this.ocrService.processPdf(pdfBuffer);
      await job.progress(55);

      // Persist OCR markdown for reference.
      await this.minioService.uploadFile(
        'ocr-output',
        `${documentId}/ocr.md`,
        Buffer.from(ocrText, 'utf-8'),
        Buffer.byteLength(ocrText, 'utf-8'),
        'text/markdown',
      );

      // Fetch title for nicer source labels in chat.
      const meta = await this.postgresService.queryOne<{ title_ar: string }>(
        `SELECT title_ar FROM documents WHERE id = $1`,
        [documentId],
      );

      // Chunk + embed + upsert in the agent (FastEmbed, 1024d, owner+case tagged).
      const { chunks } = await this.agentDocsClient.index({
        ownerId,
        caseId,
        documentId,
        documentType,
        title: meta?.title_ar,
        text: ocrText,
      });
      await job.progress(90);

      await this.postgresService.query(
        `UPDATE documents SET
           ocr_text = $1,
           word_count = $2,
           status = 'ready'
         WHERE id = $3`,
        [ocrText.slice(0, 10000), ocrText.split(/\s+/).length, documentId],
      );

      await job.progress(100);
      this.logger.log(
        `User document ${documentId} indexed (${chunks} chunks)`,
      );
    } catch (err: any) {
      this.logger.error(
        `User document processing failed for ${documentId}: ${err.message}`,
        err.stack,
      );
      await this.postgresService.query(
        `UPDATE documents SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, documentId],
      );
      throw err;
    }
  }

  /**
   * Pipeline for a file dropped straight into the main chat (no case yet).
   *
   * The LLM categorises the document. If it is a JUDGMENT it is added to the
   * shared global judgments corpus (public, OpenAI vectors in Qdrant) AND a
   * bilingual (FR/AR) Claude analysis is launched. Anything else is indexed in
   * the uploader's private FastEmbed space so they can still chat with it. In
   * both cases the document is searchable in the user's general chat.
   */
  @Process('process-chat-upload')
  async processChatUpload(job: Job<any>): Promise<void> {
    const { documentId, bucket, key, ownerId } = job.data;

    try {
      this.logger.log(`Processing chat upload: ${documentId}`);
      const pdfBuffer = await this.minioService.downloadFile(bucket, key);
      await job.progress(5);

      // Page images for the inline viewer (best-effort).
      try {
        await this.renderAndUploadPages(documentId, pdfBuffer);
        await job.progress(20);
      } catch (pageErr: any) {
        this.logger.error(
          `Page rendering failed for ${documentId}: ${pageErr?.message || pageErr}`,
        );
        await this.postgresService.query(
          `UPDATE documents SET pages_status = 'failed' WHERE id = $1`,
          [documentId],
        );
      }

      // OCR via Mistral.
      const ocrText = await this.ocrService.processPdf(pdfBuffer);
      await job.progress(45);
      await this.minioService.uploadFile(
        'ocr-output',
        `${documentId}/ocr.md`,
        Buffer.from(ocrText, 'utf-8'),
        Buffer.byteLength(ocrText, 'utf-8'),
        'text/markdown',
      );

      // Categorise: judgment vs. anything else (judgment-focused detection).
      const judgmentClass = await this.classifierService.classifyJudgment(
        ocrText,
        this.openai,
      );
      const isJudgment = judgmentClass.isJudgment;
      const collection = judgmentClass.collection;
      const classification = isJudgment
        ? await this.classifierService.classify(ocrText, this.openai)
        : { jurisdiction: {} as any };
      this.logger.log(
        `Chat upload ${documentId} classified as ${collection} (judgment=${isJudgment})`,
      );
      await job.progress(60);

      const meta = await this.postgresService.queryOne<{ title_ar: string }>(
        `SELECT title_ar FROM documents WHERE id = $1`,
        [documentId],
      );
      const title =
        this.buildJudgmentTitle(classification, meta?.title_ar) ||
        meta?.title_ar ||
        'مستند';

      if (isJudgment) {
        // Add to the shared global judgments corpus (best-effort — OpenAI
        // vectors). Never let a corpus embedding hiccup fail the whole upload.
        try {
          await this.indexJudgmentUpload(
            documentId,
            ownerId,
            collection,
            ocrText,
            classification,
            title,
          );
        } catch (idxErr: any) {
          this.logger.error(
            `Global corpus indexing failed for ${documentId}: ${idxErr.message}`,
          );
        }
        // Always index in the uploader's FastEmbed space so they can chat with
        // it (and all their judgments) regardless of corpus embedding state.
        try {
          await this.agentDocsClient.index({
            ownerId,
            caseId: CHAT_UPLOAD_INBOX_CASE,
            documentId,
            documentType: 'judgment',
            title,
            text: ocrText,
          });
        } catch (agErr: any) {
          this.logger.warn(
            `Agent indexing failed for judgment ${documentId}: ${agErr.message}`,
          );
        }
        await job.progress(85);

        // Launch the bilingual Claude analysis on the same PDF.
        const analysisId = uuidv4();
        await this.postgresService.query(
          `INSERT INTO judgment_analyses
             (id, filename, pdf_bucket, pdf_key, status, prompt_version, created_by)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
          [analysisId, title, bucket, key, JUDGMENT_PROMPT_VERSION, ownerId || null],
        );
        await this.judgmentQueue.add('analyze', {
          analysisId,
          bucket,
          key,
        });

        await this.postgresService.query(
          `UPDATE documents SET
             title_ar = $1,
             collection = $2,
             document_type = 'judgment',
             visibility = 'public',
             status = 'published',
             ocr_text = $3,
             word_count = $4,
             jurisdiction = $5,
             metadata = jsonb_build_object(
               'chatUpload', true, 'isJudgment', true, 'analysisId', $6::text)
           WHERE id = $7`,
          [
            title,
            collection,
            ocrText.slice(0, 10000),
            ocrText.split(/\s+/).length,
            JSON.stringify(classification.jurisdiction || {}),
            analysisId,
            documentId,
          ],
        );
      } else {
        // Not a judgment: keep it private to the uploader and index it in the
        // agent so it is available in the user's general chat.
        await this.agentDocsClient.index({
          ownerId,
          caseId: CHAT_UPLOAD_INBOX_CASE,
          documentId,
          documentType: 'other',
          title: meta?.title_ar,
          text: ocrText,
        });
        await job.progress(85);

        await this.postgresService.query(
          `UPDATE documents SET
             collection = 'user_documents',
             document_type = 'other',
             visibility = 'private',
             status = 'ready',
             ocr_text = $1,
             word_count = $2,
             metadata = jsonb_build_object('chatUpload', true, 'isJudgment', false)
           WHERE id = $3`,
          [ocrText.slice(0, 10000), ocrText.split(/\s+/).length, documentId],
        );
      }

      await job.progress(100);
      this.logger.log(`Chat upload ${documentId} processed (judgment=${isJudgment})`);
    } catch (err: any) {
      this.logger.error(
        `Chat upload processing failed for ${documentId}: ${err.message}`,
        err.stack,
      );
      await this.postgresService.query(
        `UPDATE documents SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, documentId],
      );
      throw err;
    }
  }

  /** Chunk + OpenAI-embed + upsert a judgment into the shared global corpus. */
  private async indexJudgmentUpload(
    documentId: string,
    ownerId: string | null,
    collection: string,
    ocrText: string,
    classification: any,
    title: string,
  ): Promise<void> {
    const chunks = this.chunkingService.chunkDocument(ocrText, collection);
    const chunkTexts = chunks.map((c) => c.content);
    const embeddings = await this.embeddingService.embedBatch(chunkTexts);

    await this.postgresService.transaction(async (client) => {
      await client.query(
        `DELETE FROM document_chunks WHERE document_id = $1`,
        [documentId],
      );
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await client.query(
          `INSERT INTO document_chunks
             (id, document_id, chunk_index, content, article_ref, collection)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            uuidv4(),
            documentId,
            chunk.chunkIndex,
            chunk.content,
            chunk.articleRef || null,
            collection,
          ],
        );
      }
    });

    const qdrantPoints = chunks.map((chunk, i) => ({
      id: this.generateQdrantId(documentId, i),
      vector: embeddings[i],
      payload: {
        document_id: documentId,
        owner_id: ownerId || null,
        visibility: 'public',
        collection,
        title,
        content: chunk.content,
        article_ref: chunk.articleRef || null,
        chunk_index: chunk.chunkIndex,
      },
    }));

    await this.qdrantService.upsert(collection, qdrantPoints);
  }

  /** Compose a readable Arabic title from the classifier's jurisdiction hints. */
  private buildJudgmentTitle(
    classification: any,
    fallback?: string | null,
  ): string | null {
    const j = classification?.jurisdiction || {};
    const parts = [j.courtName, j.caseNumber, j.date].filter(Boolean);
    if (parts.length === 0) return fallback || null;
    return parts.join(' — ');
  }

  /**
   * Render every page of the PDF to a PNG with pdftoppm (poppler-utils),
   * upload each image to a per-document MinIO bucket (named with the
   * document UUID), and insert a row into document_pages.
   *
   * Pages appear incrementally — the frontend polls /admin/documents/:id/pages
   * and shows pages as they become available.
   */
  private async renderAndUploadPages(
    documentId: string,
    pdfBuffer: Buffer,
  ): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), 'doc-pages', documentId);
    await fs.mkdir(tmpDir, { recursive: true });
    const pdfPath = path.join(tmpDir, 'source.pdf');
    await fs.writeFile(pdfPath, pdfBuffer);

    await this.postgresService.query(
      `UPDATE documents SET pages_status = 'running' WHERE id = $1`,
      [documentId],
    );

    // Per-document bucket: name = document UUID.
    await this.minioService.ensureBucket(documentId);

    // Render all pages as page-001.png, page-002.png, ...
    // pdftoppm root prefix means it writes "<prefix>-1.png", "<prefix>-2.png", etc.
    // We use a numeric width via --separator-style, but pdftoppm pads automatically
    // when we pass the total page count via -f/-l. Simpler: rename after.
    const prefix = path.join(tmpDir, 'page');
    await this.runPdftoppm(prefix, pdfPath);

    // Read written files, sort by numeric suffix, upload one-by-one.
    const entries = await fs.readdir(tmpDir);
    const pngs = entries
      .filter((e) => e.startsWith('page-') && e.endsWith('.png'))
      .map((name) => {
        const m = name.match(/^page-(\d+)\.png$/);
        return { name, n: m ? parseInt(m[1], 10) : NaN };
      })
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n);

    for (const { name, n } of pngs) {
      const filePath = path.join(tmpDir, name);
      const buf = await fs.readFile(filePath);
      const paddedKey = `page-${String(n).padStart(4, '0')}.png`;

      await this.minioService.uploadFile(
        documentId,
        paddedKey,
        buf,
        buf.length,
        'image/png',
      );

      await this.postgresService.query(
        `INSERT INTO document_pages
           (document_id, page_number, minio_bucket, minio_key, file_size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (document_id, page_number) DO UPDATE
           SET minio_bucket = EXCLUDED.minio_bucket,
               minio_key = EXCLUDED.minio_key,
               file_size_bytes = EXCLUDED.file_size_bytes`,
        [documentId, n, documentId, paddedKey, buf.length],
      );
    }

    await this.postgresService.query(
      `UPDATE documents SET page_count = $2, pages_status = 'completed' WHERE id = $1`,
      [documentId, pngs.length],
    );

    this.logger.log(`Rendered ${pngs.length} pages for ${documentId}`);

    // Best-effort cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  private runPdftoppm(prefix: string, pdfPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-png', '-r', String(PAGE_DPI), pdfPath, prefix];
      const child = spawn('pdftoppm', args);
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
      child.on('error', (err) =>
        reject(new Error(`pdftoppm spawn failed: ${err.message}`)),
      );
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
      });
    });
  }

  private generateQdrantId(documentId: string, chunkIndex: number): number {
    // Generate a deterministic numeric ID from documentId + chunkIndex
    const str = `${documentId}-${chunkIndex}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    // Make positive and scale to avoid collisions
    return Math.abs(hash) * 1000 + chunkIndex;
  }
}
