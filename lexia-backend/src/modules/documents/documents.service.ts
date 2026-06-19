import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../../database/postgres.service';
import { MinioService } from '../storage/minio.service';
import { AgentDocsClient } from '../agent-docs/agent-docs.client';
import { AuthUser } from '../../common/guards/keycloak.guard';
import { normalizeDocumentType } from './document-types';
import {
  assertLegalClassification,
  resolveLegalClassification,
} from './legal-classification';
import { JUDGMENT_PROMPT_VERSION } from '../admin/judgment-analysis/prompts';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private postgresService: PostgresService,
    private minioService: MinioService,
    private agentDocsClient: AgentDocsClient,
    private configService: ConfigService,
    @InjectQueue('document-processing') private docQueue: Queue,
    @InjectQueue('judgment-analysis') private judgmentQueue: Queue,
  ) {}

  async uploadDocument(
    file: Express.Multer.File,
    user: AuthUser,
    options: {
      visibility?: string;
      titleAr?: string;
      titleFr?: string;
      collection?: string;
      sourceType?: string;
      ownerTypeOverride?: 'system' | 'user';
      caseId?: string;
      documentType?: string;
    } = {},
  ): Promise<any> {
    if (!file) throw new BadRequestException('Aucun fichier fourni');

    const docId = uuidv4();
    const ownerType = options.ownerTypeOverride || (user.userId ? 'user' : 'system');

    // For user uploads: enforce PDF, a valid owned case, the taxonomy, and quota.
    let caseId: string | null = null;
    let documentType: string | null = null;
    if (ownerType === 'user') {
      if (!user.userId) {
        throw new ForbiddenException('Authentication required');
      }
      if (file.mimetype !== 'application/pdf') {
        throw new BadRequestException('Seuls les fichiers PDF sont acceptés');
      }
      const maxBytes = this.configService.get<number>('uploads.maxFileSizeBytes');
      if (maxBytes && file.size > maxBytes) {
        throw new BadRequestException('Fichier trop volumineux');
      }
      if (!options.caseId) {
        throw new BadRequestException('caseId est requis');
      }
      caseId = await this.assertCaseOwnership(options.caseId, user.userId);
      documentType = normalizeDocumentType(options.documentType);
      await this.assertWithinQuota(user.userId);
    }

    const bucket = ownerType === 'system' ? 'raw-pdfs' : 'user-uploads';
    const key = `${docId}/${file.originalname}`;
    const collection = options.collection || 'user_documents';
    const sourceType = options.sourceType || 'user_upload';
    const visibility =
      options.visibility || (ownerType === 'system' ? 'public' : 'private');

    await this.minioService.uploadFile(
      bucket,
      key,
      file.buffer,
      file.size,
      file.mimetype,
    );

    const doc = await this.postgresService.queryOne<any>(
      `INSERT INTO documents
         (id, title_ar, title_fr, collection, source_type, owner_type, owner_id,
          case_id, document_type, status, visibility, minio_bucket, minio_key,
          file_size_bytes, content_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing', $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        docId,
        options.titleAr || file.originalname,
        options.titleFr || null,
        collection,
        sourceType,
        ownerType,
        user.userId || null,
        caseId,
        documentType,
        visibility,
        bucket,
        key,
        file.size,
        file.mimetype,
      ],
    );

    if (ownerType === 'user' && user.userId) {
      await this.incrementUploadUsage(user.userId, file.size);
    }

    const job = await this.docQueue.add(
      'process-document',
      {
        documentId: docId,
        bucket,
        key,
        ownerType,
        ownerId: user.userId,
        caseId,
        documentType,
      },
      {
        jobId: `document-upload-${docId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    await this.postgresService.query(
      `UPDATE documents
       SET metadata = metadata || jsonb_build_object(
             'processingJobId', $1::text,
             'taskStartedAt', NOW()::text
           ),
           updated_at = NOW()
       WHERE id = $2`,
      [String(job.id), docId],
    );

    return {
      document: doc,
      taskId: `upload:${docId}`,
      jobId: job.id,
    };
  }

  // ─── Quota helpers ──────────────────────────────────────────

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  /** Monthly upload cap: active paid plan's limit, else the configured default. */
  private async getMonthlyUploadLimit(userId: string): Promise<number> {
    const fallback =
      this.configService.get<number>('uploads.defaultMonthlyQuota') || 100;
    try {
      const plan = await this.postgresService.queryOne<{
        max_uploads_per_month: number;
        has_upload: boolean;
      }>(
        `SELECT p.max_uploads_per_month, p.has_upload
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status IN ('active', 'trial')
         LIMIT 1`,
        [userId],
      );
      if (plan && plan.has_upload && plan.max_uploads_per_month > 0) {
        return plan.max_uploads_per_month;
      }
    } catch (err) {
      this.logger.warn(`Quota lookup failed for ${userId}: ${err.message}`);
    }
    return fallback;
  }

  private async assertWithinQuota(userId: string): Promise<void> {
    const month = this.currentMonth();
    const limit = await this.getMonthlyUploadLimit(userId);
    const row = await this.postgresService.queryOne<{ documents_uploaded: number }>(
      `SELECT documents_uploaded FROM user_upload_quotas
       WHERE user_id = $1 AND month = $2`,
      [userId, month],
    );
    const used = row?.documents_uploaded || 0;
    if (used >= limit) {
      throw new ForbiddenException(
        `تم بلوغ الحد الشهري للرفع (${limit}). يرجى الترقية أو المحاولة لاحقاً.`,
      );
    }
  }

  private async incrementUploadUsage(
    userId: string,
    sizeBytes: number,
  ): Promise<void> {
    const month = this.currentMonth();
    await this.postgresService.query(
      `INSERT INTO user_upload_quotas
         (user_id, month, documents_uploaded, storage_used_bytes)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, month) DO UPDATE
         SET documents_uploaded = user_upload_quotas.documents_uploaded + 1,
             storage_used_bytes = user_upload_quotas.storage_used_bytes + $3`,
      [userId, month, sizeBytes],
    );
  }

  async getUploadQuota(userId: string): Promise<{
    used: number;
    limit: number;
    month: string;
  }> {
    const month = this.currentMonth();
    const limit = await this.getMonthlyUploadLimit(userId);
    const row = await this.postgresService.queryOne<{ documents_uploaded: number }>(
      `SELECT documents_uploaded FROM user_upload_quotas
       WHERE user_id = $1 AND month = $2`,
      [userId, month],
    );
    return { used: row?.documents_uploaded || 0, limit, month };
  }

  // ─── Case ownership ─────────────────────────────────────────

  private async assertCaseOwnership(
    caseId: string,
    userId: string,
  ): Promise<string> {
    const row = await this.postgresService.queryOne<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM cases WHERE id = $1`,
      [caseId],
    );
    if (!row) throw new NotFoundException('Case not found');
    if (row.owner_id !== userId) throw new ForbiddenException('Access denied');
    return row.id;
  }

  // ─── Document queries ───────────────────────────────────────

  async getMyDocuments(userId: string): Promise<any[]> {
    return this.postgresService.query<any>(
      `SELECT * FROM documents WHERE owner_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
  }

  async getCaseDocuments(caseId: string, userId: string): Promise<any[]> {
    await this.assertCaseOwnership(caseId, userId);
    return this.postgresService.query<any>(
      `SELECT d.id, d.title_ar, d.title_fr, d.document_type, d.status, d.pages_status,
              d.page_count, d.file_size_bytes, d.content_type, d.created_at, d.error_message,
              COALESCE(ja.id::text, d.metadata->>'analysisId') AS analysis_id,
              ja.status AS analysis_status,
              (ja.status = 'completed') AS summary_ready
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT j.id, j.status
         FROM judgment_analyses j
         WHERE (
           (d.metadata->>'analysisId' IS NOT NULL AND j.id = (d.metadata->>'analysisId')::uuid)
           OR (
             j.pdf_bucket = d.minio_bucket
             AND j.pdf_key = d.minio_key
           )
         )
           AND j.status IN ('pending', 'running', 'completed')
         ORDER BY
           CASE j.status
             WHEN 'completed' THEN 0
             WHEN 'running' THEN 1
             WHEN 'pending' THEN 2
             ELSE 3
           END,
           j.completed_at DESC NULLS LAST,
           j.created_at DESC
         LIMIT 1
       ) ja ON true
       WHERE d.case_id = $1 AND d.owner_id = $2
       ORDER BY d.created_at DESC`,
      [caseId, userId],
    );
  }

  /** Fetch a document and verify the caller owns it. */
  async getOwnedDocument(id: string, userId: string): Promise<any> {
    const doc = await this.postgresService.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1`,
      [id],
    );
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.owner_id !== userId) throw new ForbiddenException('Access denied');
    return doc;
  }

  async getJobStatus(jobId: string): Promise<any> {
    const job = await this.docQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');

    const state = await job.getState();
    const progress = job.progress();

    return {
      jobId,
      state,
      progress,
      data: job.data,
      failedReason: job.failedReason,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };
  }

  // ─── Page viewer (owner-scoped) ─────────────────────────────

  async listPages(id: string, userId: string): Promise<{
    pages: Array<{ page_number: number; width: number | null; height: number | null }>;
    pagesStatus: string | null;
    pageCount: number | null;
  }> {
    const doc = await this.getOwnedDocument(id, userId);
    const pages = await this.postgresService.query<{
      page_number: number;
      width: number | null;
      height: number | null;
    }>(
      `SELECT page_number, width, height
       FROM document_pages
       WHERE document_id = $1
       ORDER BY page_number ASC`,
      [id],
    );
    return {
      pages,
      pagesStatus: doc.pages_status,
      pageCount: doc.page_count,
    };
  }

  async getPageUrl(
    id: string,
    pageNumber: number,
    userId: string,
  ): Promise<{ url: string; expiresIn: number }> {
    await this.getOwnedDocument(id, userId);
    const page = await this.postgresService.queryOne<{
      minio_bucket: string;
      minio_key: string;
    }>(
      `SELECT minio_bucket, minio_key FROM document_pages
       WHERE document_id = $1 AND page_number = $2`,
      [id, pageNumber],
    );
    if (!page) throw new NotFoundException('Page introuvable');
    const expiresIn = 3600;
    const url = await this.minioService.getPresignedUrl(
      page.minio_bucket,
      page.minio_key,
      expiresIn,
    );
    return { url, expiresIn };
  }

  // ─── Deletion (cascade physical artifacts) ──────────────────

  /** Remove a document's MinIO objects and Qdrant vectors. Best-effort. */
  private async purgeDocumentArtifacts(doc: any): Promise<void> {
    // Raw upload + OCR output
    await this.minioService.tryDeleteFile(doc.minio_bucket, doc.minio_key);
    await this.minioService.tryDeleteFile('ocr-output', `${doc.id}/ocr.md`);
    // Per-document page-image bucket (bucket name = document UUID)
    await this.minioService.removeBucketRecursive(doc.id);
    // FastEmbed vectors in the agent's Qdrant collection
    if (doc.owner_id) {
      try {
        await this.agentDocsClient.deleteDocument(doc.owner_id, doc.id);
      } catch (err) {
        this.logger.warn(
          `Agent vector delete failed for ${doc.id}: ${err.message}`,
        );
      }
    }
  }

  async deleteDocument(id: string, userId: string): Promise<void> {
    const doc = await this.getOwnedDocument(id, userId);
    await this.purgeDocumentArtifacts(doc);
    // document_pages cascade via FK; chunks (if any) cascade too.
    await this.postgresService.query(`DELETE FROM documents WHERE id = $1`, [id]);
  }

  /** Purge artifacts for every document in a case (used before dropping a case). */
  async purgeCaseDocuments(caseId: string, ownerId: string): Promise<void> {
    const docs = await this.postgresService.query<any>(
      `SELECT id, owner_id, minio_bucket, minio_key FROM documents WHERE case_id = $1`,
      [caseId],
    );
    for (const doc of docs) {
      await this.purgeDocumentArtifacts(doc);
    }
    // Sweep any stray vectors for the whole case in one call.
    try {
      await this.agentDocsClient.deleteCase(ownerId, caseId);
    } catch (err) {
      this.logger.warn(`Agent case sweep failed for ${caseId}: ${err.message}`);
    }
  }

  async updateVisibility(
    id: string,
    userId: string,
    visibility: string,
  ): Promise<any> {
    await this.getOwnedDocument(id, userId);
    return this.postgresService.queryOne<any>(
      `UPDATE documents SET visibility = $1 WHERE id = $2 RETURNING *`,
      [visibility, id],
    );
  }

  async updateDocumentType(
    id: string,
    userId: string,
    documentType: string,
  ): Promise<any> {
    const doc = await this.getOwnedDocument(id, userId);
    const normalized = normalizeDocumentType(documentType);

    const updated = await this.postgresService.queryOne<any>(
      `UPDATE documents
       SET document_type = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [normalized, id],
    );

    if (
      doc.status === 'ready' &&
      doc.ocr_text &&
      doc.owner_id &&
      doc.case_id
    ) {
      try {
        await this.agentDocsClient.index({
          ownerId: doc.owner_id,
          caseId: doc.case_id,
          documentId: id,
          documentType: normalized,
          title: doc.title_ar,
          text: doc.ocr_text,
        });
      } catch (err: any) {
        this.logger.warn(
          `Agent re-index after type change failed for ${id}: ${err.message}`,
        );
      }
    }

    return updated;
  }

  async updateDocumentTitle(
    id: string,
    userId: string,
    titleAr: string,
  ): Promise<{ id: string; title_ar: string }> {
    const trimmed = titleAr?.trim();
    if (!trimmed) {
      throw new BadRequestException('Le titre est requis');
    }
    if (trimmed.length > 255) {
      throw new BadRequestException('Le titre est trop long (255 caractères max)');
    }

    const doc = await this.getOwnedDocument(id, userId);
    const updated = await this.postgresService.queryOne<any>(
      `UPDATE documents
       SET title_ar = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, title_ar`,
      [trimmed, id],
    );

    if (
      doc.status === 'ready' &&
      doc.ocr_text &&
      doc.owner_id &&
      doc.case_id
    ) {
      try {
        await this.agentDocsClient.index({
          ownerId: doc.owner_id,
          caseId: doc.case_id,
          documentId: id,
          documentType: doc.document_type || 'other',
          title: trimmed,
          text: doc.ocr_text,
        });
      } catch (err: any) {
        this.logger.warn(
          `Agent re-index after title change failed for ${id}: ${err.message}`,
        );
      }
    }

    return updated;
  }

  async updateDocumentLegalClassification(
    id: string,
    userId: string,
    legalFamily: string,
    legalClass: string,
  ): Promise<{
    id: string;
    legal_family: string;
    legal_class: string;
    classification_manual: boolean;
  }> {
    let validated: { family: string; legalClass: string };
    try {
      validated = assertLegalClassification(legalFamily, legalClass);
    } catch {
      throw new BadRequestException('تصنيف قانوني غير صالح');
    }

    await this.getOwnedDocument(id, userId);

    const patch = {
      legal_family: validated.family,
      legal_class: validated.legalClass,
      legal_class_manual: true,
    };

    await this.postgresService.query(
      `UPDATE documents
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(patch), id],
    );

    return {
      id,
      legal_family: validated.family,
      legal_class: validated.legalClass,
      classification_manual: true,
    };
  }

  async resetDocumentLegalClassification(
    id: string,
    userId: string,
  ): Promise<{
    id: string;
    legal_family: string;
    legal_class: string;
    classification_manual: boolean;
  }> {
    const doc = await this.getOwnedDocument(id, userId);
    await this.postgresService.query(
      `UPDATE documents
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         - 'legal_family' - 'legal_class' - 'legal_class_manual',
           updated_at = NOW()
       WHERE id = $1`,
      [id],
    );

    const classification = resolveLegalClassification({
      collection: doc.collection,
      document_type: doc.document_type,
      title_ar: doc.title_ar,
      title_fr: doc.title_fr,
      metadata: {},
    });

    return {
      id,
      legal_family: classification.family,
      legal_class: classification.legalClass,
      classification_manual: false,
    };
  }

  async suggestDocumentTitle(
    id: string,
    userId: string,
  ): Promise<{ suggestedTitle: string }> {
    const doc = await this.getOwnedDocument(id, userId);
    const sample = await this.getDocumentTextSample(doc);

    const client = new OpenAI({
      apiKey: this.configService.get<string>('llm.apiKey'),
      baseURL: this.configService.get<string>('llm.baseURL') || undefined,
    });
    const model =
      this.configService.get<string>('llm.chatModel') || 'gpt-4o';
    const chunksPreview = this.formatChunksPreview(sample, 1500, 3);
    const typeLabel = doc.document_type || 'other';

    const response = await client.chat.completions.create({
      model,
      temperature: 0.25,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You name Moroccan legal PDF documents for lawyers.
Read the opening chunks and return JSON: { "title": "..." }.
Rules:
- Arabic title, concise and descriptive (court, parties, subject, or date if obvious)
- No file extension, no quotes inside
- Max 80 characters
- Prefer formal legal wording`,
        },
        {
          role: 'user',
          content: `نوع المستند: ${typeLabel}
الاسم الحالي: ${doc.title_ar || '—'}

مقتطفات من بداية الوثيقة:
${chunksPreview}`,
        },
      ],
    });

    let suggestedTitle = doc.title_ar;
    try {
      const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        suggestedTitle = parsed.title.trim().slice(0, 255);
      }
    } catch (err: any) {
      this.logger.warn(`Title suggestion parse failed for ${id}: ${err.message}`);
      throw new BadRequestException('تعذّر توليد اسم مقترح');
    }

    return { suggestedTitle };
  }

  private async getDocumentTextSample(doc: any): Promise<string> {
    if (doc.ocr_text?.trim()) {
      return doc.ocr_text.trim();
    }

    try {
      const buffer = await this.minioService.downloadFile(
        'ocr-output',
        `${doc.id}/ocr.md`,
      );
      const text = buffer.toString('utf-8').trim();
      if (text) return text;
    } catch {
      /* fall through */
    }

    if (doc.status === 'processing') {
      throw new BadRequestException(
        'المستند قيد المعالجة — انتظر اكتمال استخراج النص',
      );
    }

    throw new BadRequestException(
      'لا يتوفر نص لهذا المستند بعد — لا يمكن اقتراح اسم',
    );
  }

  private formatChunksPreview(
    text: string,
    chunkSize: number,
    maxChunks: number,
  ): string {
    const chunks: string[] = [];
    for (let i = 0; i < maxChunks; i++) {
      const start = i * chunkSize;
      const slice = text.slice(start, start + chunkSize);
      if (!slice.trim()) break;
      chunks.push(`--- مقطع ${i + 1} ---\n${slice.trim()}`);
    }
    return chunks.join('\n\n');
  }

  /** Launch bilingual judgment summary for a case document marked as judgment. */
  async requestJudgmentSummary(
    id: string,
    userId: string,
  ): Promise<{
    analysisId: string;
    analysisStatus: string;
    jobId: string | number;
  }> {
    const doc = await this.getOwnedDocument(id, userId);
    return this.enqueueJudgmentAnalysis(doc, userId);
  }

  /** Shared corpus summary — any user with access can trigger; stored on the document row. */
  async requestSharedJudgmentSummary(
    id: string,
    user: AuthUser,
  ): Promise<{
    analysisId: string;
    analysisStatus: string;
    jobId: string | number;
  }> {
    const doc = await this.getDocumentIfAccessible(id, user);
    if (!doc) throw new NotFoundException('Document not found');
    if (!user.userId) throw new ForbiddenException('Authentication required');
    return this.enqueueJudgmentAnalysis(doc, user.userId);
  }

  async getSharedJudgmentSummary(
    id: string,
    user?: AuthUser,
  ): Promise<{ status: string; markdown: string; error: string | null }> {
    const doc = await this.getDocumentIfAccessible(id, user);
    if (!doc) throw new NotFoundException('Document not found');
    const analysisId = await this.resolveJudgmentAnalysisId(doc);
    if (!analysisId) {
      throw new NotFoundException('Aucune analyse pour ce document');
    }
    const row = await this.postgresService.queryOne<{
      status: string;
      markdown_result: string | null;
      error_message: string | null;
    }>(
      `SELECT status, markdown_result, error_message
       FROM judgment_analyses WHERE id = $1`,
      [analysisId],
    );
    if (!row) throw new NotFoundException('Analyse introuvable');
    return {
      status: row.status,
      markdown: row.markdown_result || '',
      error: row.error_message,
    };
  }

  async getSharedJudgmentAnalysisId(
    id: string,
    user?: AuthUser,
  ): Promise<string> {
    const doc = await this.getDocumentIfAccessible(id, user);
    if (!doc) throw new NotFoundException('Document not found');
    const analysisId = await this.resolveJudgmentAnalysisId(doc);
    if (!analysisId) {
      throw new NotFoundException('Aucune analyse pour ce document');
    }
    return analysisId;
  }

  /** Resolve analysis id from document metadata or an existing row for the same PDF. */
  private async resolveJudgmentAnalysisId(doc: any): Promise<string | null> {
    const fromMeta: string | null = doc.metadata?.analysisId || null;
    if (fromMeta) return fromMeta;

    const existing = await this.findExistingAnalysisForPdf(
      doc.minio_bucket,
      doc.minio_key,
    );
    if (!existing) return null;

    await this.linkDocumentToAnalysis(doc.id, existing.id);
    return existing.id;
  }

  private async findExistingAnalysisForPdf(
    bucket: string,
    key: string,
  ): Promise<{ id: string; status: string } | null> {
    return this.postgresService.queryOne<{ id: string; status: string }>(
      `SELECT id, status
       FROM judgment_analyses
       WHERE pdf_bucket = $1 AND pdf_key = $2
         AND status IN ('pending', 'running', 'completed')
       ORDER BY
         CASE status
           WHEN 'completed' THEN 0
           WHEN 'running' THEN 1
           WHEN 'pending' THEN 2
           ELSE 3
         END,
         completed_at DESC NULLS LAST,
         created_at DESC
       LIMIT 1`,
      [bucket, key],
    );
  }

  private async linkDocumentToAnalysis(
    documentId: string,
    analysisId: string,
  ): Promise<void> {
    await this.postgresService.query(
      `UPDATE documents
       SET metadata = metadata || jsonb_build_object(
             'analysisId', $1::text,
             'sharedJudgmentSummary', true
           ),
           updated_at = NOW()
       WHERE id = $2`,
      [analysisId, documentId],
    );
  }

  private async getDocumentIfAccessible(
    id: string,
    user?: AuthUser,
  ): Promise<any | null> {
    const doc = await this.postgresService.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1`,
      [id],
    );
    if (!doc) return null;

    const accessLevel = user?.accessLevel || 'PUBLIC';
    const userId = user?.userId;

    if (accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN') {
      return doc;
    }
    if (userId && doc.owner_id === userId) {
      return doc;
    }
    if (doc.status !== 'published') {
      return null;
    }
    if (doc.visibility === 'public') {
      return doc;
    }
    if (
      doc.visibility === 'pro_only' &&
      userId &&
      accessLevel !== 'PUBLIC'
    ) {
      return doc;
    }
    return null;
  }

  private assertSummarizableJudgment(doc: any): void {
    const isJudgment =
      doc.document_type === 'judgment' ||
      (typeof doc.collection === 'string' &&
        doc.collection.startsWith('judgments_'));
    if (!isJudgment) {
      throw new BadRequestException('Le document doit être un حكم');
    }
    if (doc.status !== 'ready' && doc.status !== 'published') {
      throw new BadRequestException(
        'Le document doit être entièrement traité avant le résumé',
      );
    }
  }

  private async enqueueJudgmentAnalysis(
    doc: any,
    userId: string | null,
  ): Promise<{
    analysisId: string;
    analysisStatus: string;
    jobId: string | number;
  }> {
    this.assertSummarizableJudgment(doc);

    const linkedId = await this.resolveJudgmentAnalysisId(doc);
    if (linkedId) {
      const existing = await this.postgresService.queryOne<{
        id: string;
        status: string;
      }>(
        `SELECT id, status FROM judgment_analyses WHERE id = $1`,
        [linkedId],
      );
      if (
        existing &&
        (existing.status === 'pending' ||
          existing.status === 'running' ||
          existing.status === 'completed')
      ) {
        return {
          analysisId: existing.id,
          analysisStatus: existing.status,
          jobId: doc.metadata?.analysisJobId || '',
        };
      }
    }

    const analysisId = uuidv4();
    await this.postgresService.query(
      `INSERT INTO judgment_analyses
         (id, filename, pdf_bucket, pdf_key, status, prompt_version, created_by)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [
        analysisId,
        doc.title_ar,
        doc.minio_bucket,
        doc.minio_key,
        JUDGMENT_PROMPT_VERSION,
        userId,
      ],
    );

    const job = await this.judgmentQueue.add(
      'analyze',
      {
        analysisId,
        bucket: doc.minio_bucket,
        key: doc.minio_key,
      },
      {
        jobId: `judgment-doc-${analysisId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    await this.postgresService.query(
      `UPDATE documents
       SET metadata = metadata || jsonb_build_object(
             'analysisId', $1::text,
             'analysisJobId', $2::text,
             'sharedJudgmentSummary', true
           ),
           updated_at = NOW()
       WHERE id = $3`,
      [analysisId, String(job.id), doc.id],
    );

    return {
      analysisId,
      analysisStatus: 'pending',
      jobId: job.id,
    };
  }

  // ─── Admin review (unchanged) ───────────────────────────────

  async getPendingDocuments(): Promise<any[]> {
    return this.postgresService.query<any>(
      `SELECT d.*, u.email as owner_email
       FROM documents d
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.status = 'pending_review'
       ORDER BY d.created_at ASC`,
    );
  }

  async approveDocument(id: string, adminId: string): Promise<any> {
    const doc = await this.postgresService.queryOne<any>(
      `UPDATE documents
       SET status = 'published', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [adminId, id],
    );

    if (!doc) throw new NotFoundException('Document not found');

    await this.docQueue.add('process-document', {
      documentId: id,
      bucket: doc.minio_bucket,
      key: doc.minio_key,
      ownerType: doc.owner_type,
      ownerId: doc.owner_id,
      reindex: true,
    });

    return doc;
  }

  async rejectDocument(id: string, adminId: string, reason: string): Promise<any> {
    const doc = await this.postgresService.queryOne<any>(
      `UPDATE documents
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
           rejection_reason = $3
       WHERE id = $2
       RETURNING *`,
      [adminId, id, reason],
    );

    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }
}
