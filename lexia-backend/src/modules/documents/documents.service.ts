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
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private postgresService: PostgresService,
    private minioService: MinioService,
    private agentDocsClient: AgentDocsClient,
    private configService: ConfigService,
    @InjectQueue('document-processing') private docQueue: Queue,
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

    const job = await this.docQueue.add('process-document', {
      documentId: docId,
      bucket,
      key,
      ownerType,
      ownerId: user.userId,
      caseId,
      documentType,
    });

    return { document: doc, jobId: job.id };
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
      `SELECT id, title_ar, title_fr, document_type, status, pages_status,
              page_count, file_size_bytes, content_type, created_at, error_message
       FROM documents
       WHERE case_id = $1 AND owner_id = $2
       ORDER BY created_at DESC`,
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
