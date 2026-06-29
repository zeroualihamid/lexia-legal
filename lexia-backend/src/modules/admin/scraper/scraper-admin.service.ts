import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PostgresService } from '../../../database/postgres.service';
import { FileReferenceScraperService } from '../../scraper/file-reference-scraper.service';
import { ScrapeByFileReferenceOptions } from '../../scraper/file-reference.types';
import { CorpusSchedulerService, CORPUS_JOB_OPTS } from '../../queue/corpus-scheduler.service';

@Injectable()
export class ScraperAdminService {
  constructor(
    private postgresService: PostgresService,
    @InjectQueue('scraping') private scrapingQueue: Queue,
    @InjectQueue('document-processing') private docQueue: Queue,
    private fileReferenceScraper: FileReferenceScraperService,
    private corpusScheduler: CorpusSchedulerService,
  ) {}

  async getSources(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT s.*,
              COALESCE(
                (SELECT COUNT(*)::int FROM documents d
                 WHERE d.metadata->>'scraperSourceId' = s.id::text),
                0
              ) AS docs_count
       FROM sources s
       ORDER BY s.created_at DESC`,
    );
  }

  private buildSourceConfig(data: Record<string, any>, existing: Record<string, any> = {}): Record<string, any> {
    const config: Record<string, any> = { ...existing };

    if (data.max_pages !== undefined) config.max_pages = data.max_pages;
    if (data.max_downloads !== undefined) config.max_downloads = data.max_downloads;
    if (data.corpus_target !== undefined) {
      config.corpus_target = data.corpus_target;
      config.corpus_mode = true;
      if (config.corpus_downloaded === undefined) config.corpus_downloaded = 0;
      if (config.start_page === undefined) config.start_page = 1;
      if (config.subject_index === undefined) config.subject_index = 0;
    }
    if (data.batch_downloads !== undefined) config.batch_downloads = data.batch_downloads;
    if (data.search_subject !== undefined) config.search_subject = data.search_subject;
    if (data.search_subjects_text !== undefined) {
      config.search_subjects = String(data.search_subjects_text)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!config.locale) config.locale = 'ar';

    return config;
  }

  async createSource(data: {
    name_ar: string;
    name_fr?: string;
    url: string;
    scraper_type: string;
    collection: string;
    is_active?: boolean;
    max_pages?: number;
    max_downloads?: number;
    corpus_target?: number;
    batch_downloads?: number;
    search_subject?: string;
    search_subjects_text?: string;
  }): Promise<any> {
    const config = this.buildSourceConfig(data, {
      max_pages: data.max_pages ?? 10,
      max_downloads: data.max_downloads ?? 100,
    });

    return this.postgresService.queryOne(
      `INSERT INTO sources
         (name_ar, name_fr, url, scraper_type, collection, is_active, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        data.name_ar,
        data.name_fr || null,
        data.url,
        data.scraper_type,
        data.collection,
        data.is_active !== undefined ? data.is_active : true,
        JSON.stringify(config),
      ],
    );
  }

  async updateSource(id: string, data: any): Promise<any> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM sources WHERE id = $1`,
      [id],
    );
    if (!source) throw new NotFoundException('Source not found');

    const config = this.buildSourceConfig(data, source.config || {});

    return this.postgresService.queryOne(
      `UPDATE sources SET
         name_ar = $1,
         name_fr = $2,
         url = $3,
         scraper_type = $4,
         collection = $5,
         is_active = $6,
         config = $7::jsonb
       WHERE id = $8
       RETURNING *`,
      [
        data.name_ar ?? source.name_ar,
        data.name_fr !== undefined ? data.name_fr : source.name_fr,
        data.url ?? source.url,
        data.scraper_type ?? source.scraper_type,
        data.collection ?? source.collection,
        data.is_active !== undefined ? data.is_active : source.is_active,
        JSON.stringify(config),
        id,
      ],
    );
  }

  async deleteSource(id: string): Promise<void> {
    const result = await this.postgresService.queryOne(
      `DELETE FROM sources WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('Source not found');
  }

  async enqueueScraping(id: string): Promise<any> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM sources WHERE id = $1`,
      [id],
    );
    if (!source) throw new NotFoundException('Source not found');

    const config = source.config || {};
    const useCorpus = Boolean(config.corpus_target || config.corpus_mode);
    const jobName = useCorpus ? 'scrape-corpus-batch' : 'scrape-source';

    const job = await this.scrapingQueue.add(jobName, {
      sourceId: id,
      url: source.url,
      scraperType: source.scraper_type,
      collection: source.collection,
      maxPages: config.max_pages ?? 10,
      maxDownloads: config.max_downloads ?? 100,
      folderId: config.folderId,
      fileRessourceId: config.fileRessourceId,
      searchSubject: config.search_subject,
      fileReferences: config.file_references,
      courtName: config.court_name,
      fileCode: config.file_code,
      fileYears: config.file_years,
      fileNumberStart: config.file_number_start,
      fileNumberEnd: config.file_number_end,
      locale: config.locale || 'ar',
    }, useCorpus ? {
      jobId: `corpus-batch-${id}`,
      ...CORPUS_JOB_OPTS,
    } : undefined);

    return { jobId: job.id, sourceId: id, jobType: jobName };
  }

  async previewScrapeByReference(body: ScrapeByFileReferenceOptions) {
    const result = await this.fileReferenceScraper.scrape(body);
    return {
      ...result,
      pdf: result.pdf ? `[${result.pdf.length} bytes]` : undefined,
    };
  }

  async enqueueScrapeByReference(body: {
    fileReference: string;
    courtName?: string;
    courtType?: 'appeal' | 'first_instance' | 'cassation';
    collection?: string;
    searchSubject?: string;
    locale?: 'ar' | 'en' | 'fr';
  }) {
    const job = await this.scrapingQueue.add('scrape-by-reference', {
      fileReference: body.fileReference,
      courtName: body.courtName,
      courtType: body.courtType,
      collection: body.collection || 'judgments_civil',
      searchSubject: body.searchSubject,
      locale: body.locale,
    });

    return { jobId: job.id, fileReference: body.fileReference };
  }

  async getMonitor(): Promise<{
    queue: { active: number; waiting: number; failed: number };
    corpusSources: Array<{
      id: string;
      name_ar: string;
      name_fr: string | null;
      collection: string;
      downloaded: number;
      target: number;
      percent: number;
      last_status: string | null;
      last_batch: number | null;
      subject: string | null;
      start_page: number | null;
      docs_count: number;
      last_error: string | null;
    }>;
  }> {
    const [active, waiting, failedJobs] = await Promise.all([
      this.scrapingQueue.getActive(),
      this.scrapingQueue.getWaiting(),
      this.scrapingQueue.getFailed(0, 50),
    ]);

    const corpusRows = await this.postgresService.query<any>(
      `SELECT s.id, s.name_ar, s.name_fr, s.collection, s.config,
              COALESCE(
                (SELECT COUNT(*)::int FROM documents d
                 WHERE d.metadata->>'scraperSourceId' = s.id::text),
                0
              ) AS docs_count
       FROM sources s
       WHERE (s.config->>'corpus_target') IS NOT NULL
       ORDER BY s.created_at DESC`,
    );

    const corpusSources = corpusRows.map((s) => {
      const cfg = s.config || {};
      const target = Number(cfg.corpus_target || 0);
      const downloaded = Number(cfg.corpus_downloaded ?? 0);
      const percent = target > 0 ? Math.min(100, Math.round((downloaded / target) * 100)) : 0;
      const subjects: string[] = cfg.search_subjects || [];
      const subjectIdx = Number(cfg.subject_index ?? 0);
      return {
        id: s.id,
        name_ar: s.name_ar,
        name_fr: s.name_fr,
        collection: s.collection,
        downloaded,
        target,
        percent,
        last_status: cfg.last_status ?? null,
        last_batch: cfg.last_run_count != null ? Number(cfg.last_run_count) : null,
        subject: subjects[subjectIdx] || cfg.search_subject || null,
        start_page: cfg.start_page != null ? Number(cfg.start_page) : null,
        docs_count: s.docs_count,
        last_error: cfg.last_error ?? null,
      };
    });

    return {
      queue: {
        active: active.length,
        waiting: waiting.length,
        failed: failedJobs.length,
      },
      corpusSources,
    };
  }

  async getJobs(): Promise<any[]> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.scrapingQueue.getWaiting(),
      this.scrapingQueue.getActive(),
      this.scrapingQueue.getCompleted(0, 40),
      this.scrapingQueue.getFailed(0, 15),
    ]);

    const sources = await this.postgresService.query<any>(
      `SELECT id, name_ar, name_fr, config FROM sources`,
    );
    const sourceMap = new Map(sources.map((s) => [s.id, s]));

    const formatJob = (job: any, status: string) => {
      const data = job.data || {};
      const source = data.sourceId ? sourceMap.get(data.sourceId) : null;
      const cfg = source?.config || {};
      const corpusTarget = Number(cfg.corpus_target || 0);
      const corpusDownloaded = Number(cfg.corpus_downloaded || 0);
      const rawProgress = job.progress();

      let progress = 0;
      let progressLabel = '';
      let batchCount: number | null = null;

      if (job.name === 'scrape-corpus-batch' && corpusTarget > 0) {
        progress = Math.min(100, Math.round((corpusDownloaded / corpusTarget) * 100));
        progressLabel = `${corpusDownloaded.toLocaleString()} / ${corpusTarget.toLocaleString()} PDF`;
        if (status === 'running' && typeof rawProgress === 'object' && rawProgress?.lastBatch != null) {
          batchCount = Number(rawProgress.lastBatch);
        } else if (cfg.last_run_count != null && status !== 'pending') {
          batchCount = Number(cfg.last_run_count);
        }
      } else if (typeof rawProgress === 'object' && rawProgress != null && 'percent' in rawProgress) {
        progress = Number(rawProgress.percent) || 0;
        progressLabel = rawProgress.label || '';
      } else if (typeof rawProgress === 'number') {
        progress = rawProgress;
      }

      if (job.name === 'scrape-by-reference' && data.fileReference) {
        progressLabel = data.fileReference;
      }

      const subjects: string[] = cfg.search_subjects || [];
      const subjectIdx = Number(cfg.subject_index ?? 0);

      return {
        id: job.id,
        status,
        type: job.name || 'scrape',
        data,
        source_id: data.sourceId || null,
        source_name_ar: source?.name_ar || null,
        source_name_fr: source?.name_fr || null,
        progress,
        progressLabel,
        batchCount,
        corpus:
          corpusTarget > 0
            ? {
                downloaded: corpusDownloaded,
                target: corpusTarget,
                percent: progress,
                subject: subjects[subjectIdx] || cfg.search_subject || null,
                startPage: cfg.start_page != null ? Number(cfg.start_page) : null,
                lastStatus: cfg.last_status ?? null,
              }
            : null,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        created_at: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      };
    };

    const formatted = [
      ...active.map((j) => formatJob(j, 'running')),
      ...waiting.map((j) => formatJob(j, 'pending')),
      ...failed.map((j) => formatJob(j, 'failed')),
    ];

    // Keep recent completed jobs; collapse old corpus batches to latest per source.
    const completedFormatted = completed.map((j) => formatJob(j, 'completed'));
    const corpusLatest = new Map<string, any>();
    const otherCompleted: any[] = [];

    for (const job of completedFormatted) {
      if (job.type === 'scrape-corpus-batch' && job.source_id) {
        const prev = corpusLatest.get(job.source_id);
        if (!prev || Number(job.id) > Number(prev.id)) {
          corpusLatest.set(job.source_id, job);
        }
      } else {
        otherCompleted.push(job);
      }
    }

    return [
      ...formatted,
      ...Array.from(corpusLatest.values()),
      ...otherCompleted.slice(0, 10),
    ].sort((a, b) => {
      const order = { running: 0, pending: 1, failed: 2, completed: 3 };
      const sa = order[a.status as keyof typeof order] ?? 9;
      const sb = order[b.status as keyof typeof order] ?? 9;
      if (sa !== sb) return sa - sb;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  }

  async getJob(jobId: string): Promise<any> {
    const job = await this.scrapingQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');

    const state = await job.getState();
    const [formatted] = await this.getJobs().then((jobs) =>
      jobs.filter((j) => String(j.id) === String(jobId)),
    );

    if (formatted) return { ...formatted, state };

    const data = job.data || {};
    return {
      id: job.id,
      state,
      status: state,
      type: job.name || 'scrape',
      data,
      progress: job.progress(),
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = await this.scrapingQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');
    await job.remove();
  }

  async reindexDocument(documentId: string): Promise<any> {
    const doc = await this.postgresService.queryOne<any>(
      `SELECT * FROM documents WHERE id = $1`,
      [documentId],
    );
    if (!doc) throw new NotFoundException('Document not found');

    const job = await this.docQueue.add('process-document', {
      documentId,
      bucket: doc.minio_bucket,
      key: doc.minio_key,
      ownerType: doc.owner_type,
      reindex: true,
    });

    return { jobId: job.id };
  }

  /** Clear legacy document-processing jobs (OCR backlog) and align DB rows to ready/PDF-only. */
  async drainDocumentProcessingQueue(): Promise<{
    waitingRemoved: number;
    delayedRemoved: number;
    documentsUpdated: number;
  }> {
    const waitingBefore = await this.docQueue.getWaitingCount();
    const delayedBefore = await this.docQueue.getDelayedCount();

    await this.docQueue.empty();
    await this.docQueue.clean(0, 'delayed');
    await this.docQueue.clean(0, 'failed');

    const updated = await this.postgresService.query<{ id: string }>(
      `UPDATE documents SET
         status = 'ready',
         pages_status = COALESCE(pages_status, 'pending'),
         metadata = COALESCE(metadata, '{}'::jsonb) || '{"indexingDeferred": true}'::jsonb
       WHERE status = 'processing'
         AND minio_bucket IS NOT NULL
         AND minio_key IS NOT NULL
         AND minio_key <> ''
         AND COALESCE(file_size_bytes, 0) > 0
         AND (
           metadata->>'sourceUrl' LIKE '%juriscassation.cspj.ma%'
           OR metadata->>'scraperSourceId' IS NOT NULL
         )
       RETURNING id`,
    );

    return {
      waitingRemoved: waitingBefore,
      delayedRemoved: delayedBefore,
      documentsUpdated: updated.length,
    };
  }

  async resumeCorpusSource(sourceId: string): Promise<{ queued: boolean; message: string }> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT id FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!source) throw new NotFoundException('Source not found');
    return this.corpusScheduler.resumeCorpusSource(sourceId);
  }

  /** Enqueue OCR/embedding for deferred corpus PDFs (phase 2 — run after archive complete). */
  async bulkReindexDeferred(body: {
    sourceId?: string;
    limit?: number;
  }): Promise<{ enqueued: number; documentIds: string[] }> {
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 500);
    const params: any[] = [];
    let sourceFilter = '';

    if (body.sourceId) {
      params.push(body.sourceId);
      sourceFilter = `AND metadata->>'scraperSourceId' = $${params.length}`;
    }

    params.push(limit);
    const limitParam = `$${params.length}`;

    const docs = await this.postgresService.query<any>(
      `SELECT id, minio_bucket, minio_key, owner_type
       FROM documents
       WHERE status = 'ready'
         AND COALESCE(metadata->>'indexingDeferred', 'false') = 'true'
         AND minio_bucket IS NOT NULL
         AND minio_key IS NOT NULL
         AND minio_key <> ''
         ${sourceFilter}
       ORDER BY created_at ASC
       LIMIT ${limitParam}`,
      params,
    );

    const documentIds: string[] = [];
    for (const doc of docs) {
      await this.docQueue.add('process-document', {
        documentId: doc.id,
        bucket: doc.minio_bucket,
        key: doc.minio_key,
        ownerType: doc.owner_type,
        reindex: true,
      });
      documentIds.push(doc.id);
    }

    return { enqueued: documentIds.length, documentIds };
  }
}
