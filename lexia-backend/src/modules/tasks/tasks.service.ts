import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { PostgresService } from '../../database/postgres.service';

type TaskState = 'queued' | 'running' | 'completed' | 'failed';

interface QueueSnapshot {
  state: string | null;
  progress: number;
  failedReason: string | null;
  processedOn: number | null;
  finishedOn: number | null;
}

interface UploadTaskRow {
  id: string;
  title_ar: string;
  document_type: string | null;
  status: string;
  case_id: string | null;
  case_title: string | null;
  error_message: string | null;
  page_count: number | null;
  metadata: Record<string, any> | null;
  created_at: Date;
  updated_at: Date;
  analysis_status: string | null;
  analysis_error: string | null;
  analysis_started_at: Date | null;
  analysis_completed_at: Date | null;
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly postgres: PostgresService,
    @InjectQueue('document-processing')
    private readonly documentQueue: Queue,
    @InjectQueue('judgment-analysis')
    private readonly judgmentQueue: Queue,
  ) {}

  async listUploadTasks(userId: string): Promise<any[]> {
    const rows = await this.postgres.query<UploadTaskRow>(
      `SELECT d.id,
              d.title_ar,
              d.document_type,
              d.status,
              d.case_id,
              c.title AS case_title,
              d.error_message,
              d.page_count,
              d.metadata,
              d.created_at,
              d.updated_at,
              ja.status AS analysis_status,
              ja.error_message AS analysis_error,
              ja.started_at AS analysis_started_at,
              ja.completed_at AS analysis_completed_at
       FROM documents d
       LEFT JOIN cases c ON c.id = d.case_id
       LEFT JOIN judgment_analyses ja
         ON d.metadata->>'analysisId' ~* '^[0-9a-f-]{36}$'
        AND ja.id = (d.metadata->>'analysisId')::uuid
       WHERE d.owner_id = $1
       ORDER BY d.created_at DESC
       LIMIT 150`,
      [userId],
    );

    return Promise.all(rows.map((row) => this.toTask(row)));
  }

  private async toTask(row: UploadTaskRow): Promise<any> {
    const metadata = row.metadata || {};
    const [documentJob, analysisJob] = await Promise.all([
      this.getQueueSnapshot(
        this.documentQueue,
        metadata.processingJobId,
      ),
      this.getQueueSnapshot(
        this.judgmentQueue,
        metadata.analysisJobId,
      ),
    ]);

    const isJudgment =
      metadata.isJudgment === true || row.document_type === 'judgment';
    const state = this.resolveState(row, documentJob, analysisJob, isJudgment);
    const progress = this.resolveProgress(
      row,
      documentJob,
      analysisJob,
      isJudgment,
      state,
    );

    return {
      id: `upload:${row.id}`,
      kind: 'upload',
      documentId: row.id,
      title: row.title_ar,
      documentType: row.document_type,
      origin: metadata.searchUpload
        ? 'search'
        : metadata.chatUpload
          ? 'chat'
          : 'case',
      caseId: row.case_id,
      caseTitle: row.case_title,
      state,
      stage: this.resolveStage(
        row,
        documentJob,
        isJudgment,
        state,
      ),
      progress,
      pageCount: row.page_count,
      error:
        row.analysis_error ||
        row.error_message ||
        documentJob.failedReason ||
        analysisJob.failedReason ||
        null,
      redis: {
        processingJobId: metadata.processingJobId || null,
        processingState: documentJob.state,
        analysisJobId: metadata.analysisJobId || null,
        analysisState: analysisJob.state,
      },
      createdAt: row.created_at,
      updatedAt:
        row.analysis_completed_at ||
        row.analysis_started_at ||
        row.updated_at,
    };
  }

  private resolveState(
    row: UploadTaskRow,
    documentJob: QueueSnapshot,
    analysisJob: QueueSnapshot,
    isJudgment: boolean,
  ): TaskState {
    if (
      row.status === 'failed' ||
      documentJob.state === 'failed' ||
      row.analysis_status === 'failed'
    ) {
      return 'failed';
    }
    if (isJudgment && row.analysis_status === 'completed') {
      return 'completed';
    }
    if (
      !isJudgment &&
      ['ready', 'published', 'pending_review'].includes(row.status)
    ) {
      return 'completed';
    }
    if (
      documentJob.state === 'waiting' ||
      documentJob.state === 'delayed' ||
      documentJob.state === 'paused'
    ) {
      return 'queued';
    }
    if (
      isJudgment &&
      row.analysis_status === 'pending' &&
      ['waiting', 'delayed', 'paused'].includes(analysisJob.state || '')
    ) {
      return 'queued';
    }
    if (
      row.analysis_status === 'pending' &&
      !documentJob.state
    ) {
      return 'queued';
    }
    return 'running';
  }

  private resolveProgress(
    row: UploadTaskRow,
    documentJob: QueueSnapshot,
    analysisJob: QueueSnapshot,
    isJudgment: boolean,
    state: TaskState,
  ): number {
    if (state === 'completed') return 100;
    if (state === 'failed') {
      return Math.max(
        1,
        isJudgment
          ? 65 + Math.round(analysisJob.progress * 0.35)
          : documentJob.progress,
      );
    }
    if (isJudgment && row.analysis_status) {
      return Math.min(
        99,
        65 + Math.round(analysisJob.progress * 0.35),
      );
    }
    return Math.min(99, Math.max(1, documentJob.progress));
  }

  private resolveStage(
    row: UploadTaskRow,
    documentJob: QueueSnapshot,
    isJudgment: boolean,
    state: TaskState,
  ): string {
    if (state === 'completed') return 'completed';
    if (state === 'failed') return 'failed';
    if (isJudgment && row.analysis_status === 'pending') {
      return 'summary_queued';
    }
    if (isJudgment && row.analysis_status === 'running') {
      return 'summarizing';
    }
    const progress = documentJob.progress;
    if (state === 'queued') return 'queued';
    if (progress < 20) return 'preparing';
    if (progress < 60) return 'ocr';
    if (progress < 90) return 'indexing';
    return 'finalizing';
  }

  private async getQueueSnapshot(
    queue: Queue,
    jobId?: string | number | null,
  ): Promise<QueueSnapshot> {
    const empty: QueueSnapshot = {
      state: null,
      progress: 0,
      failedReason: null,
      processedOn: null,
      finishedOn: null,
    };
    if (!jobId) return empty;
    try {
      const job: Job | null = await queue.getJob(String(jobId));
      if (!job) return empty;
      const rawProgress = job.progress();
      return {
        state: await job.getState(),
        progress:
          typeof rawProgress === 'number'
            ? rawProgress
            : Number(rawProgress) || 0,
        failedReason: job.failedReason || null,
        processedOn: job.processedOn || null,
        finishedOn: job.finishedOn || null,
      };
    } catch (err: any) {
      this.logger.warn(
        `Unable to read Bull job ${jobId}: ${err.message}`,
      );
      return empty;
    }
  }
}
