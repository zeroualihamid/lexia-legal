import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { MinioService } from '../storage/minio.service';
import { PostgresService } from '../../database/postgres.service';
import { ScraperFactoryService } from '../scraper/scraper-factory.service';
import { FileReferenceScraperService } from '../scraper/file-reference-scraper.service';
import { ScrapedPage } from '../scraper/base.scraper';
import { ScrapeByFileReferenceResult } from '../scraper/file-reference.types';
import { CorpusSchedulerService } from './corpus-scheduler.service';

const TYPED_SCRAPERS = new Set([
  'sgg',
  'sgg.gov.ma',
  'adala',
  'adala.justice.gov.ma',
  'juriscassation',
  'cspj',
  'cour_cassation',
  'juriscassation.cspj.ma',
  'mahakim',
  'mahakim.ma',
  'cour_appel',
  'tribunal_appel',
]);

@Processor('scraping')
export class ScrapingProcessor {
  private readonly logger = new Logger(ScrapingProcessor.name);

  constructor(
    private minioService: MinioService,
    private postgresService: PostgresService,
    private scraperFactory: ScraperFactoryService,
    private fileReferenceScraper: FileReferenceScraperService,
    private corpusScheduler: CorpusSchedulerService,
    @InjectQueue('document-processing') private docQueue: Queue,
  ) {}

  @Process('scrape-source')
  async scrapeSource(job: Job<any>): Promise<void> {
    const {
      sourceId, url, scraperType, maxPages, maxDownloads, collection, folderId, fileRessourceId, searchSubject,
      fileReferences, courtName, fileCode, fileYears, fileNumberStart, fileNumberEnd,
    } = job.data;

    try {
      this.logger.log(`Scraping source: ${sourceId} - ${url} (${scraperType || 'generic'})`);

      await this.markRunning(sourceId);

      const processedCount = TYPED_SCRAPERS.has(String(scraperType || '').toLowerCase())
        ? await this.runTypedScraper(sourceId, {
            url,
            scraperType,
            maxPages,
            maxDownloads,
            collection: collection || 'judgments_civil',
            folderId,
            fileRessourceId,
            searchSubject,
            fileReferences,
            courtName,
            fileCode,
            fileYears,
            fileNumberStart,
            fileNumberEnd,
          })
        : await this.runGenericScraper(sourceId, url);

      await this.markComplete(sourceId, processedCount);
      this.logger.log(`Scraping complete for ${sourceId}: ${processedCount} item(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Scraping failed for ${sourceId}: ${message}`);
      await this.markError(sourceId, message);
      throw err;
    }
  }

  /** Batched CSPJ corpus scrape with checkpoint + auto re-queue (e.g. 51 770 cassation PDFs). */
  @Process('scrape-corpus-batch')
  async scrapeCorpusBatch(job: Job<any>): Promise<void> {
    const { sourceId, url, scraperType, collection, searchSubject, locale } = job.data;

    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!source) throw new Error(`Source not found: ${sourceId}`);

    const config = source.config || {};
    const corpusTarget = Number(config.corpus_target ?? config.max_downloads ?? 0);
    const batchDownloads = Number(config.batch_downloads ?? 50);
    let startPage = Number(config.start_page ?? 1);
    let subjectIndex = Number(config.subject_index ?? 0);
    let corpusDownloaded = Number(config.corpus_downloaded ?? 0);
    const subjects: string[] =
      config.search_subjects?.length > 0
        ? config.search_subjects
        : [searchSubject || config.search_subject || 'ال'];

    if (!corpusTarget || corpusDownloaded >= corpusTarget) {
      await this.markCorpusComplete(sourceId, corpusDownloaded);
      return;
    }

    await this.markRunning(sourceId);

    const remaining = corpusTarget - corpusDownloaded;
    const batchLimit = Math.min(batchDownloads, remaining);
    const pagesPerBatch = Math.max(1, Math.ceil(batchLimit / 10));
    const activeSubject = subjects[subjectIndex] || subjects[0];

    const reportProgress = async (
      downloaded: number,
      phase: 'starting' | 'downloading' | 'done',
      lastBatch = 0,
    ) => {
      const pct =
        corpusTarget > 0
          ? Math.min(phase === 'done' && downloaded >= corpusTarget ? 100 : 99, Math.round((downloaded / corpusTarget) * 100))
          : 0;
      await job.progress({
        percent: pct,
        corpusDownloaded: downloaded,
        corpusTarget,
        lastBatch,
        subject: activeSubject,
        startPage,
        phase,
        label: `${downloaded.toLocaleString()} / ${corpusTarget.toLocaleString()} PDF`,
      });
    };

    await reportProgress(corpusDownloaded, 'starting');

    this.logger.log(
      `Corpus batch ${sourceId}: subject="${activeSubject}" page=${startPage} ` +
        `batch=${batchLimit} progress=${corpusDownloaded}/${corpusTarget}`,
    );

    let processedCount = 0;
    try {
      processedCount = await this.runTypedScraper(sourceId, {
        url,
        scraperType,
        maxPages: pagesPerBatch,
        maxDownloads: batchLimit,
        collection: collection || source.collection || 'judgments_civil',
        searchSubject: activeSubject,
        startPage,
        locale,
        skipProcessing: config.skip_indexing !== false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Corpus batch failed for ${sourceId}: ${message}`);

      if (this.isTransientScrapeError(message)) {
        await this.postgresService.query(
          `UPDATE sources SET config = COALESCE(config, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
          [
            JSON.stringify({
              last_status: 'running',
              last_error: message,
              last_run_count: 0,
            }),
            sourceId,
          ],
        );
        await this.corpusScheduler.scheduleCorpusBatch(
          sourceId,
          { sourceId, url, scraperType, collection: collection || source.collection, locale },
          60_000,
        );
        this.logger.warn(
          `Corpus batch ${sourceId}: transient network error, retry queued in 60s`,
        );
        return;
      }

      await this.markError(sourceId, message);
      throw err;
    }

    corpusDownloaded += processedCount;
    startPage += pagesPerBatch;

    await reportProgress(corpusDownloaded, 'done', processedCount);

    if (processedCount === 0) {
      subjectIndex += 1;
      startPage = 1;
      this.logger.warn(
        `Corpus batch ${sourceId}: no new PDFs for subject "${activeSubject}", switching subject index → ${subjectIndex}`,
      );
    }

    const exhausted = subjectIndex >= subjects.length && processedCount === 0;
    const done = corpusDownloaded >= corpusTarget || exhausted;

    await this.postgresService.query(
      `UPDATE sources SET
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          start_page: startPage,
          subject_index: subjectIndex,
          corpus_downloaded: corpusDownloaded,
          last_status: done ? 'idle' : 'running',
          last_run_count: processedCount,
          last_error: null,
        }),
        sourceId,
      ],
    );

    if (done) {
      await job.progress({
        percent: 100,
        corpusDownloaded,
        corpusTarget,
        lastBatch: processedCount,
        subject: activeSubject,
        phase: 'done',
        label: `${corpusDownloaded.toLocaleString()} / ${corpusTarget.toLocaleString()} PDF`,
      });
      await this.markCorpusComplete(sourceId, corpusDownloaded);
      this.logger.log(`Corpus scrape finished for ${sourceId}: ${corpusDownloaded}/${corpusTarget}`);
      return;
    }

    await this.corpusScheduler.scheduleCorpusBatch(
      sourceId,
      { sourceId, url, scraperType, collection: collection || source.collection, locale },
      3000,
    );
    this.logger.log(
      `Corpus batch done for ${sourceId}: +${processedCount} (total ${corpusDownloaded}/${corpusTarget}), next batch queued`,
    );
  }

  @Process('scrape-by-reference')
  async scrapeByReference(job: Job<any>): Promise<{ processedCount: number; result: ScrapeByFileReferenceResult }> {
    const {
      fileReference,
      courtName,
      courtType,
      collection = 'judgments_civil',
      searchSubject,
      locale,
    } = job.data;

    this.logger.log(`Scrape by file reference: ${fileReference}`);

    const result = await this.fileReferenceScraper.scrape({
      fileReference,
      courtName,
      courtType,
      searchSubject,
      locale,
    });

    if (!result.found) {
      throw new Error(result.message || `لم يتم العثور على ملف ${fileReference}`);
    }

    const sourceKey = fileReference.replace(/[/\\?%*:|"<>]/g, '-');
    const pages = this.fileReferenceScraper.toScrapedPages(result);
    let processedCount = 0;

    for (const page of pages) {
      if (page.binary && page.mimeType === 'application/pdf') {
        await this.ingestPdf(
          `by-ref-${sourceKey}`,
          page,
          collection,
          'file-reference',
          processedCount,
          result,
        );
        processedCount += 1;
      } else if (page.content && page.content.length > 50) {
        await this.ingestReferenceText(sourceKey, page, collection, result);
        processedCount += 1;
      }
      await this.sleep(500);
    }

    this.logger.log(
      `Scrape by reference complete for ${fileReference}: source=${result.source} docs=${processedCount}`,
    );

    return { processedCount, result: { ...result, pdf: undefined } };
  }

  private async runTypedScraper(
    sourceId: string,
    opts: {
      url: string;
      scraperType: string;
      maxPages?: number;
      maxDownloads?: number;
      collection: string;
      folderId?: number;
      fileRessourceId?: number;
      searchSubject?: string;
      fileReferences?: string[];
      courtName?: string;
      fileCode?: string;
      fileYears?: number[];
      fileNumberStart?: number;
      fileNumberEnd?: number;
      startPage?: number;
      locale?: string;
      skipProcessing?: boolean;
    },
  ): Promise<number> {
    const scraper = this.scraperFactory.getScraper(opts.scraperType);
    const pages = await scraper.scrape({
      url: opts.url,
      maxPages: opts.maxPages || 10,
      maxDownloads: opts.maxDownloads || 100,
      startPage: opts.startPage,
      locale: opts.locale as any,
      folderId: opts.folderId,
      fileRessourceId: opts.fileRessourceId,
      searchSubject: opts.searchSubject,
      fileReferences: opts.fileReferences,
      courtName: opts.courtName,
      fileCode: opts.fileCode,
      fileYears: opts.fileYears,
      fileNumberStart: opts.fileNumberStart,
      fileNumberEnd: opts.fileNumberEnd,
    });

    let processedCount = 0;
    for (const page of pages) {
      if (page.binary && page.mimeType === 'application/pdf') {
        const ingested = await this.ingestPdf(
          sourceId,
          page,
          opts.collection,
          opts.scraperType,
          processedCount,
          undefined,
          opts.skipProcessing,
        );
        if (ingested) processedCount += 1;
      } else if (page.content && page.content.length > 50) {
        await this.ingestMahakimSnapshot(sourceId, page, opts.collection, processedCount);
        processedCount += 1;
      } else if (page.content && page.content.length > 200) {
        await this.ingestHtml(sourceId, page, processedCount);
        processedCount += 1;
      }
      await this.sleep(500);
    }
    return processedCount;
  }

  private async ingestPdf(
    sourceId: string,
    page: ScrapedPage,
    collection: string,
    scraperType: string,
    index: number,
    referenceResult?: ScrapeByFileReferenceResult,
    skipProcessing = false,
  ): Promise<string | null> {
    const existing = await this.postgresService.queryOne<{ id: string }>(
      `SELECT id FROM documents WHERE metadata->>'sourceUrl' = $1 LIMIT 1`,
      [page.url],
    );
    if (existing) return null;

    const docId = uuidv4();
    const safeName = (page.title || `decision-${index + 1}`)
      .replace(/[/\\?%*:|"<>]/g, '_')
      .slice(0, 180);
    const bucket = 'raw-pdfs';
    const key = `scrapers/${sourceId}/${docId}/${safeName}.pdf`;

    await this.minioService.uploadFile(
      bucket,
      key,
      page.binary,
      page.binary.length,
      'application/pdf',
    );

    await this.postgresService.query(
      `INSERT INTO documents
         (id, title_ar, collection, source_type, owner_type, status, visibility,
          minio_bucket, minio_key, file_size_bytes, content_type, pages_status, metadata)
       VALUES ($1, $2, $3, 'scraping', 'system', $4, 'public',
               $5, $6, $7, 'application/pdf', $8, $9::jsonb)`,
      [
        docId,
        page.title || safeName,
        collection,
        skipProcessing ? 'ready' : 'processing',
        bucket,
        key,
        page.binary.length,
        skipProcessing ? 'pending' : null,
        JSON.stringify({
          sourceUrl: page.url,
          scraperSourceId: sourceId,
          scraper: scraperType,
          indexingDeferred: skipProcessing,
          fileReference: referenceResult?.fileReference,
          scrapeSource: referenceResult?.source,
          ...(referenceResult?.metadata || {}),
        }),
      ],
    );

    if (!skipProcessing) {
      await this.docQueue.add('process-document', {
        documentId: docId,
        bucket,
        key,
        ownerType: 'system',
        sourceUrl: page.url,
      });
    }

    return docId;
  }

  private async ingestMahakimSnapshot(
    sourceId: string,
    page: ScrapedPage,
    collection: string,
    index: number,
  ): Promise<string> {
    const docId = uuidv4();
    const bucket = 'scraped-html';
    const key = `mahakim-appeal/${sourceId}/${docId}.txt`;
    const meta = page.metadata || {};

    await this.minioService.uploadFile(
      bucket,
      key,
      Buffer.from(page.content, 'utf-8'),
      Buffer.byteLength(page.content, 'utf-8'),
      'text/plain',
    );

    await this.postgresService.query(
      `INSERT INTO documents
         (id, title_ar, collection, source_type, owner_type, status, visibility,
          minio_bucket, minio_key, file_size_bytes, content_type, metadata, ocr_text)
       VALUES ($1, $2, $3, 'scraping', 'system', 'processing', 'public',
               $4, $5, $6, 'text/plain', $7::jsonb, $8)`,
      [
        docId,
        page.title || `ملف استئناf ${index + 1}`,
        collection,
        bucket,
        key,
        Buffer.byteLength(page.content, 'utf-8'),
        JSON.stringify({
          scraperSourceId: sourceId,
          scraper: 'mahakim',
          courtLevel: 'appeal',
          ...meta,
        }),
        page.content.slice(0, 50000),
      ],
    );

    await this.docQueue.add('process-document', {
      documentId: docId,
      bucket,
      key,
      ownerType: 'system',
      sourceUrl: page.url,
    });

    return docId;
  }

  private async ingestReferenceText(
    sourceKey: string,
    page: ScrapedPage,
    collection: string,
    result: ScrapeByFileReferenceResult,
  ): Promise<string> {
    const docId = uuidv4();
    const bucket = 'scraped-html';
    const key = `by-ref/${sourceKey}/${docId}.txt`;

    await this.minioService.uploadFile(
      bucket,
      key,
      Buffer.from(page.content, 'utf-8'),
      Buffer.byteLength(page.content, 'utf-8'),
      'text/plain',
    );

    await this.postgresService.query(
      `INSERT INTO documents
         (id, title_ar, collection, source_type, owner_type, status, visibility,
          minio_bucket, minio_key, file_size_bytes, content_type, metadata, ocr_text)
       VALUES ($1, $2, $3, 'scraping', 'system', 'processing', 'public',
               $4, $5, $6, 'text/plain', $7::jsonb, $8)`,
      [
        docId,
        page.title || `ملف ${result.fileReference}`,
        collection,
        bucket,
        key,
        Buffer.byteLength(page.content, 'utf-8'),
        JSON.stringify({
          fileReference: result.fileReference,
          scrapeSource: result.source,
          scrapeFormat: result.format,
          mahakim: result.mahakim,
          ...(result.metadata || {}),
        }),
        page.content.slice(0, 50000),
      ],
    );

    await this.docQueue.add('process-document', {
      documentId: docId,
      bucket,
      key,
      ownerType: 'system',
      sourceUrl: page.url,
    });

    return docId;
  }

  private async ingestHtml(
    sourceId: string,
    page: ScrapedPage,
    index: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const pageKey = `${sourceId}/${timestamp}-page-${index}.html`;

    await this.minioService.uploadFile(
      'scraped-html',
      pageKey,
      Buffer.from(page.content, 'utf-8'),
      Buffer.byteLength(page.content, 'utf-8'),
      'text/html',
    );

    if (this.isLegalDocument(page.content)) {
      await this.docQueue.add('process-document', {
        documentId: `scraped-${sourceId}-${index}`,
        bucket: 'scraped-html',
        key: pageKey,
        ownerType: 'system',
        sourceUrl: page.url,
      });
    }
  }

  private async runGenericScraper(sourceId: string, url: string): Promise<number> {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LexiaBot/1.0; +https://lexia.ma)',
        Accept: 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });

    const html = response.data as string;
    const timestamp = Date.now();
    const pageKey = `${sourceId}/${timestamp}-index.html`;

    await this.minioService.uploadFile(
      'scraped-html',
      pageKey,
      Buffer.from(html, 'utf-8'),
      Buffer.byteLength(html, 'utf-8'),
      'text/html',
    );

    const links = this.extractLinks(html, url);
    this.logger.log(`Found ${links.length} links on ${url}`);

    let processedCount = 0;
    for (const link of links.slice(0, 50)) {
      try {
        const pageResp = await axios.get(link, {
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LexiaBot/1.0)',
          },
        });

        const pageHtml = pageResp.data as string;
        await this.ingestHtml(
          sourceId,
          { url: link, title: link, content: pageHtml },
          processedCount,
        );
        processedCount += 1;
        await this.sleep(1000);
      } catch (pageErr) {
        this.logger.warn(
          `Failed to scrape page ${link}: ${pageErr instanceof Error ? pageErr.message : pageErr}`,
        );
      }
    }

    return processedCount;
  }

  private isTransientScrapeError(message: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timeout|fetch failed|network/i.test(
      message,
    );
  }

  private async markRunning(sourceId: string): Promise<void> {
    await this.postgresService.query(
      `UPDATE sources SET config = COALESCE(config, '{}'::jsonb) || '{"last_status":"running"}'::jsonb WHERE id = $1`,
      [sourceId],
    ).catch(() => undefined);
  }

  private async markCorpusComplete(sourceId: string, corpusDownloaded: number): Promise<void> {
    await this.postgresService.query(
      `UPDATE sources SET
         last_scraped_at = NOW(),
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          last_status: 'idle',
          corpus_downloaded: corpusDownloaded,
          last_error: null,
        }),
        sourceId,
      ],
    ).catch(() => undefined);
  }

  private async markComplete(sourceId: string, processedCount: number): Promise<void> {
    await this.postgresService.query(
      `UPDATE sources SET
         last_scraped_at = NOW(),
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          last_status: 'idle',
          last_run_count: processedCount,
          last_error: null,
        }),
        sourceId,
      ],
    ).catch(() => undefined);
  }

  private async markError(sourceId: string, message: string): Promise<void> {
    await this.postgresService.query(
      `UPDATE sources SET
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          last_status: 'error',
          last_error: message,
        }),
        sourceId,
      ],
    ).catch(() => undefined);
  }

  private extractLinks(html: string, baseUrl: string): string[] {
    const linkRegex = /href=["']([^"']+)["']/gi;
    const links: string[] = [];
    let match: RegExpExecArray;

    const base = new URL(baseUrl);

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      try {
        const fullUrl = new URL(href, baseUrl);
        if (fullUrl.hostname === base.hostname) {
          links.push(fullUrl.toString());
        }
      } catch {
        // skip invalid URLs
      }
    }

    return [...new Set(links)];
  }

  private isLegalDocument(html: string): boolean {
    const legalKeywords = [
      'المادة', 'الفصل', 'ظهير', 'قانون', 'مرسوم',
      'حكم', 'قرار', 'محكمة', 'هيئة', 'مداولة',
    ];
    return legalKeywords.some((kw) => html.includes(kw));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
