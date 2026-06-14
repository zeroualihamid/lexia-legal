import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { PostgresService } from '../../database/postgres.service';
import { MinioService } from '../storage/minio.service';
import { AgentDocsClient } from '../agent-docs/agent-docs.client';
import { CasesService } from '../cases/cases.service';
import { AuthUser } from '../../common/guards/keycloak.guard';

export const CHAT_UPLOAD_BUCKET = 'user-uploads';

export interface ChatUploadStatus {
  id: string;
  filename: string;
  status: string; // processing | ready | published | failed
  documentType: string | null;
  collection: string | null;
  isJudgment: boolean;
  caseId: string | null;
  analysisId: string | null;
  analysisStatus: string | null; // pending | running | completed | failed
  summaryReady: boolean;
  pageCount: number | null;
  errorMessage: string | null;
}

interface LinkPayload {
  caseId?: string;
  newCase?: { title: string; clientName?: string };
}

@Injectable()
export class ChatUploadsService {
  private readonly logger = new Logger(ChatUploadsService.name);

  constructor(
    private readonly postgres: PostgresService,
    private readonly minio: MinioService,
    private readonly agentDocsClient: AgentDocsClient,
    private readonly casesService: CasesService,
    private readonly configService: ConfigService,
    @InjectQueue('document-processing') private readonly docQueue: Queue,
  ) {}

  /** Accept a file dropped in the main chat, store it and start processing. */
  async create(
    file: Express.Multer.File,
    user: AuthUser,
  ): Promise<{ documentId: string; jobId: string | number }> {
    if (!file) throw new BadRequestException('Aucun fichier fourni');
    if (!user.userId) throw new ForbiddenException('Authentication required');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Seuls les fichiers PDF sont acceptés');
    }
    const maxBytes = this.configService.get<number>('uploads.maxFileSizeBytes');
    if (maxBytes && file.size > maxBytes) {
      throw new BadRequestException('Fichier trop volumineux');
    }

    const docId = uuidv4();
    const key = `${docId}/${file.originalname}`;

    await this.minio.uploadFile(
      CHAT_UPLOAD_BUCKET,
      key,
      file.buffer,
      file.size,
      file.mimetype,
    );

    const doc = await this.postgres.queryOne<any>(
      `INSERT INTO documents
         (id, title_ar, collection, source_type, owner_type, owner_id,
          document_type, status, visibility, minio_bucket, minio_key,
          file_size_bytes, content_type, metadata)
       VALUES ($1, $2, 'user_documents', 'user_upload', 'user', $3,
               NULL, 'processing', 'private', $4, $5, $6, $7,
               jsonb_build_object('chatUpload', true))
       RETURNING id`,
      [
        docId,
        file.originalname,
        user.userId,
        CHAT_UPLOAD_BUCKET,
        key,
        file.size,
        file.mimetype,
      ],
    );

    const job = await this.docQueue.add('process-chat-upload', {
      documentId: doc.id,
      bucket: CHAT_UPLOAD_BUCKET,
      key,
      ownerId: user.userId,
    });

    return { documentId: doc.id, jobId: job.id };
  }

  /** Status + classification + summary readiness for a chat upload. */
  async getStatus(id: string, userId: string): Promise<ChatUploadStatus> {
    const doc = await this.getOwnedDoc(id, userId);
    const meta = doc.metadata || {};
    const analysisId: string | null = meta.analysisId || null;

    let analysisStatus: string | null = null;
    if (analysisId) {
      const row = await this.postgres.queryOne<{ status: string }>(
        `SELECT status FROM judgment_analyses WHERE id = $1`,
        [analysisId],
      );
      analysisStatus = row?.status || null;
    }

    return {
      id: doc.id,
      filename: doc.title_ar,
      status: doc.status,
      documentType: doc.document_type,
      collection: doc.collection,
      isJudgment: !!meta.isJudgment,
      caseId: doc.case_id,
      analysisId,
      analysisStatus,
      summaryReady: analysisStatus === 'completed',
      pageCount: doc.page_count,
      errorMessage: doc.error_message,
    };
  }

  /** The bilingual (FR/AR) Claude summary markdown for a judgment upload. */
  async getSummary(
    id: string,
    userId: string,
  ): Promise<{ status: string; markdown: string; error: string | null }> {
    const doc = await this.getOwnedDoc(id, userId);
    const analysisId: string | null = doc.metadata?.analysisId || null;
    if (!analysisId) {
      throw new NotFoundException('Aucune analyse pour ce document');
    }
    const row = await this.postgres.queryOne<{
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

  /** Stream the original uploaded PDF (ownership-checked). */
  async getPdf(
    id: string,
    userId: string,
  ): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
    const doc = await this.getOwnedDoc(id, userId);
    const buffer = await this.minio.downloadFile(doc.minio_bucket, doc.minio_key);
    return {
      filename: doc.title_ar || 'document.pdf',
      buffer,
      contentType: doc.content_type || 'application/pdf',
    };
  }

  /** List every judgment the user has uploaded via the main chat (only theirs). */
  async listMyJudgments(userId: string): Promise<ChatUploadStatus[]> {
    const rows = await this.postgres.query<any>(
      `SELECT d.id, d.title_ar, d.status, d.collection, d.document_type,
              d.case_id, d.page_count, d.error_message,
              d.metadata->>'analysisId' AS analysis_id,
              ja.status AS analysis_status
       FROM documents d
       LEFT JOIN judgment_analyses ja
         ON d.metadata->>'analysisId' IS NOT NULL
        AND ja.id = (d.metadata->>'analysisId')::uuid
       WHERE d.owner_id = $1 AND d.document_type = 'judgment'
       ORDER BY d.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.title_ar,
      status: r.status,
      documentType: r.document_type,
      collection: r.collection,
      isJudgment: true,
      caseId: r.case_id,
      analysisId: r.analysis_id,
      analysisStatus: r.analysis_status,
      summaryReady: r.analysis_status === 'completed',
      pageCount: r.page_count,
      errorMessage: r.error_message,
    }));
  }

  /** Resolve the analysis id (for SSE streaming) after ownership check. */
  async getAnalysisId(id: string, userId: string): Promise<string> {
    const doc = await this.getOwnedDoc(id, userId);
    const analysisId: string | null = doc.metadata?.analysisId || null;
    if (!analysisId) throw new NotFoundException('Aucune analyse pour ce document');
    return analysisId;
  }

  /** Attach a chat upload to an existing case (or a freshly created one). */
  async linkToCase(
    id: string,
    userId: string,
    payload: LinkPayload,
  ): Promise<{ caseId: string; caseTitle: string }> {
    const doc = await this.getOwnedDoc(id, userId);

    let caseId = payload.caseId;
    let caseTitle = '';
    if (caseId) {
      const c = await this.casesService.get(caseId, userId); // throws if not owned
      caseTitle = c.title;
    } else if (payload.newCase?.title) {
      const created = await this.casesService.create(userId, {
        title: payload.newCase.title,
        clientName: payload.newCase.clientName,
      });
      caseId = created.id;
      caseTitle = created.title;
    } else {
      throw new BadRequestException('caseId ou newCase requis');
    }

    await this.postgres.query(
      `UPDATE documents SET case_id = $1, updated_at = NOW() WHERE id = $2`,
      [caseId, id],
    );

    // Re-index under the real case so it surfaces in the case workspace chat.
    if (doc.ocr_text) {
      try {
        await this.agentDocsClient.index({
          ownerId: userId,
          caseId,
          documentId: id,
          documentType: doc.document_type || 'judgment',
          title: doc.title_ar,
          text: doc.ocr_text,
        });
      } catch (err: any) {
        this.logger.warn(
          `Agent re-index after link failed for ${id}: ${err.message}`,
        );
      }
    }

    return { caseId, caseTitle };
  }

  private async getOwnedDoc(id: string, userId: string): Promise<any> {
    const doc = await this.postgres.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1`,
      [id],
    );
    if (!doc) throw new NotFoundException('Document introuvable');
    if (doc.owner_id !== userId) throw new ForbiddenException('Access denied');
    return doc;
  }
}
