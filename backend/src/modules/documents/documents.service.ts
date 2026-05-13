import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PostgresService } from '../../database/postgres.service';
import { MinioService } from '../storage/minio.service';
import { AuthUser } from '../../common/guards/keycloak.guard';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private postgresService: PostgresService,
    private minioService: MinioService,
    @InjectQueue('document-processing') private docQueue: Queue,
  ) {}

  async uploadDocument(
    file: Express.Multer.File,
    user: AuthUser,
    options: { visibility?: string; titleAr?: string; titleFr?: string } = {},
  ): Promise<any> {
    const docId = uuidv4();
    const bucket = user.userId ? 'user-uploads' : 'raw-pdfs';
    const key = `${docId}/${file.originalname}`;

    await this.minioService.uploadFile(
      bucket,
      key,
      file.buffer,
      file.size,
      file.mimetype,
    );

    const ownerType = user.userId ? 'user' : 'system';

    const doc = await this.postgresService.queryOne<any>(
      `INSERT INTO documents
         (id, title_ar, title_fr, owner_id, owner_type, status, visibility,
          storage_bucket, storage_key, file_size, content_type)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        docId,
        options.titleAr || file.originalname,
        options.titleFr || null,
        user.userId || null,
        ownerType,
        options.visibility || 'private',
        bucket,
        key,
        file.size,
        file.mimetype,
      ],
    );

    const job = await this.docQueue.add('process-document', {
      documentId: docId,
      bucket,
      key,
      ownerType,
      ownerId: user.userId,
    });

    return { document: doc, jobId: job.id };
  }

  async getMyDocuments(userId: string): Promise<any[]> {
    return this.postgresService.query<any>(
      `SELECT * FROM documents WHERE owner_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
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

  async deleteDocument(id: string, userId: string): Promise<void> {
    const doc = await this.postgresService.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1`,
      [id],
    );

    if (!doc) throw new NotFoundException('Document not found');
    if (doc.owner_id !== userId) throw new ForbiddenException('Access denied');

    await this.minioService.deleteFile(doc.storage_bucket, doc.storage_key);

    await this.postgresService.query(
      `DELETE FROM documents WHERE id = $1`,
      [id],
    );
  }

  async updateVisibility(
    id: string,
    userId: string,
    visibility: string,
  ): Promise<any> {
    const doc = await this.postgresService.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1 AND owner_id = $2`,
      [id, userId],
    );

    if (!doc) throw new NotFoundException('Document not found');

    return this.postgresService.queryOne<any>(
      `UPDATE documents SET visibility = $1 WHERE id = $2 RETURNING *`,
      [visibility, id],
    );
  }

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

    // Re-enqueue for indexing with published status
    await this.docQueue.add('process-document', {
      documentId: id,
      bucket: doc.storage_bucket,
      key: doc.storage_key,
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
