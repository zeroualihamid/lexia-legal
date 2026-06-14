import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import { PostgresService } from '../../../database/postgres.service';
import { MinioService } from '../../storage/minio.service';
import { AuthUser } from '../../../common/guards/keycloak.guard';
import { JUDGMENT_PROMPT_VERSION } from './prompts';

export const JUDGMENTS_BUCKET = 'judgments';

export interface JudgmentAnalysisRow {
  id: string;
  filename: string;
  pdf_bucket: string;
  pdf_key: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  markdown_result: string | null;
  error_message: string | null;
  model: string | null;
  prompt_version: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

@Injectable()
export class JudgmentAnalysisService {
  private readonly logger = new Logger(JudgmentAnalysisService.name);
  private bucketReady = false;

  constructor(
    private postgres: PostgresService,
    private minio: MinioService,
    @InjectQueue('judgment-analysis') private queue: Queue,
  ) {}

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const client = this.minio.getClient();
    const exists = await client.bucketExists(JUDGMENTS_BUCKET);
    if (!exists) {
      await client.makeBucket(JUDGMENTS_BUCKET, 'us-east-1');
      this.logger.log(`Created MinIO bucket: ${JUDGMENTS_BUCKET}`);
    }
    this.bucketReady = true;
  }

  async create(
    file: Express.Multer.File,
    user: AuthUser,
  ): Promise<{ analysisId: string; jobId: string | number }> {
    if (!file) throw new BadRequestException('Aucun fichier fourni');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Seuls les fichiers PDF sont acceptés');
    }

    await this.ensureBucket();

    const analysisId = uuidv4();
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
    const key = `${analysisId}/${safeName}`;

    await this.minio.uploadFile(
      JUDGMENTS_BUCKET,
      key,
      file.buffer,
      file.size,
      file.mimetype,
    );

    await this.postgres.query(
      `INSERT INTO judgment_analyses
         (id, filename, pdf_bucket, pdf_key, status, prompt_version, created_by)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [
        analysisId,
        file.originalname,
        JUDGMENTS_BUCKET,
        key,
        JUDGMENT_PROMPT_VERSION,
        user.userId || null,
      ],
    );

    const job = await this.queue.add('analyze', {
      analysisId,
      bucket: JUDGMENTS_BUCKET,
      key,
    });

    return { analysisId, jobId: job.id };
  }

  async list(limit = 50, offset = 0): Promise<JudgmentAnalysisRow[]> {
    return this.postgres.query<JudgmentAnalysisRow>(
      `SELECT id, filename, pdf_bucket, pdf_key, status, markdown_result,
              error_message, model, prompt_version, created_by,
              created_at, started_at, completed_at
       FROM judgment_analyses
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async getOne(id: string): Promise<JudgmentAnalysisRow> {
    const row = await this.postgres.queryOne<JudgmentAnalysisRow>(
      `SELECT id, filename, pdf_bucket, pdf_key, status, markdown_result,
              error_message, model, prompt_version, created_by,
              created_at, started_at, completed_at
       FROM judgment_analyses
       WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Analyse introuvable');
    return row;
  }

  async getPdf(
    id: string,
  ): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
    const row = await this.getOne(id);
    let buffer: Buffer;

    try {
      buffer = await this.minio.downloadFile(row.pdf_bucket, row.pdf_key);
    } catch (err: any) {
      this.logger.warn(
        `Original PDF missing for analysis ${id}: ${err?.message || err}`,
      );
      throw new NotFoundException('Fichier PDF original introuvable');
    }

    return {
      filename: row.filename,
      buffer,
      contentType: 'application/pdf',
    };
  }

  async rerun(
    id: string,
  ): Promise<{ analysisId: string; jobId: string | number }> {
    const original = await this.getOne(id);

    const newId = uuidv4();
    await this.postgres.query(
      `INSERT INTO judgment_analyses
         (id, filename, pdf_bucket, pdf_key, status, prompt_version, created_by)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [
        newId,
        original.filename,
        original.pdf_bucket,
        original.pdf_key,
        JUDGMENT_PROMPT_VERSION,
        original.created_by,
      ],
    );

    const job = await this.queue.add('analyze', {
      analysisId: newId,
      bucket: original.pdf_bucket,
      key: original.pdf_key,
    });

    return { analysisId: newId, jobId: job.id };
  }
}
