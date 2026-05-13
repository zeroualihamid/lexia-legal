import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PostgresService } from '../../../database/postgres.service';

@Injectable()
export class ScraperAdminService {
  constructor(
    private postgresService: PostgresService,
    @InjectQueue('scraping') private scrapingQueue: Queue,
    @InjectQueue('document-processing') private docQueue: Queue,
  ) {}

  async getSources(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM scraping_sources ORDER BY created_at DESC`,
    );
  }

  async createSource(data: {
    name: string;
    url: string;
    scraper_type: string;
    schedule_cron?: string;
    is_active?: boolean;
    max_pages?: number;
  }): Promise<any> {
    return this.postgresService.queryOne(
      `INSERT INTO scraping_sources
         (name, url, scraper_type, schedule_cron, is_active, max_pages, pages_scraped, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'idle')
       RETURNING *`,
      [
        data.name,
        data.url,
        data.scraper_type,
        data.schedule_cron || null,
        data.is_active !== undefined ? data.is_active : true,
        data.max_pages || 50,
      ],
    );
  }

  async updateSource(id: string, data: any): Promise<any> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM scraping_sources WHERE id = $1`,
      [id],
    );
    if (!source) throw new NotFoundException('Source not found');

    return this.postgresService.queryOne(
      `UPDATE scraping_sources SET
         name = $1, url = $2, scraper_type = $3, schedule_cron = $4,
         is_active = $5, max_pages = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        data.name || source.name,
        data.url || source.url,
        data.scraper_type || source.scraper_type,
        data.schedule_cron !== undefined ? data.schedule_cron : source.schedule_cron,
        data.is_active !== undefined ? data.is_active : source.is_active,
        data.max_pages || source.max_pages,
        id,
      ],
    );
  }

  async deleteSource(id: string): Promise<void> {
    const result = await this.postgresService.queryOne(
      `DELETE FROM scraping_sources WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('Source not found');
  }

  async enqueueScraping(id: string): Promise<any> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM scraping_sources WHERE id = $1`,
      [id],
    );
    if (!source) throw new NotFoundException('Source not found');

    const job = await this.scrapingQueue.add('scrape-source', {
      sourceId: id,
      url: source.url,
      scraperType: source.scraper_type,
      maxPages: source.max_pages,
    });

    return { jobId: job.id, sourceId: id };
  }

  async getJobs(): Promise<any[]> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.scrapingQueue.getWaiting(),
      this.scrapingQueue.getActive(),
      this.scrapingQueue.getCompleted(0, 20),
      this.scrapingQueue.getFailed(0, 10),
    ]);

    const formatJob = (job: any, status: string) => ({
      id: job.id,
      status,
      data: job.data,
      progress: job.progress(),
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    });

    return [
      ...active.map((j) => formatJob(j, 'active')),
      ...waiting.map((j) => formatJob(j, 'waiting')),
      ...completed.map((j) => formatJob(j, 'completed')),
      ...failed.map((j) => formatJob(j, 'failed')),
    ];
  }

  async getJob(jobId: string): Promise<any> {
    const job = await this.scrapingQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');

    const state = await job.getState();
    return {
      id: job.id,
      state,
      data: job.data,
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
      bucket: doc.storage_bucket,
      key: doc.storage_key,
      ownerType: doc.owner_type,
      ownerId: doc.owner_id,
      reindex: true,
    });

    return { jobId: job.id };
  }
}
