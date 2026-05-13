import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { MinioService } from '../storage/minio.service';
import { MistralOcrService } from '../ocr/mistral-ocr.service';
import { AutoClassifierService } from '../documents/auto-classifier.service';
import { ChunkingService } from '../chat/agent/chunking.service';
import { EmbeddingService } from '../chat/agent/embedding.service';
import { QdrantService } from '../../database/qdrant.service';
import { PostgresService } from '../../database/postgres.service';

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
    private configService: ConfigService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
  }

  @Process('process-document')
  async processDocument(job: Job<any>): Promise<void> {
    const { documentId, bucket, key, ownerType, ownerId, reindex } = job.data;

    try {
      // 1. Fetch PDF from MinIO
      this.logger.log(`Processing document: ${documentId}`);
      const pdfBuffer = await this.minioService.downloadFile(bucket, key);
      await job.progress(10);

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
