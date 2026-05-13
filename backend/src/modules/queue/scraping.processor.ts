import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';
import { MinioService } from '../storage/minio.service';
import { PostgresService } from '../../database/postgres.service';

@Processor('scraping')
export class ScrapingProcessor {
  private readonly logger = new Logger(ScrapingProcessor.name);

  constructor(
    private minioService: MinioService,
    private postgresService: PostgresService,
    @InjectQueue('document-processing') private docQueue: Queue,
  ) {}

  @Process('scrape-source')
  async scrapeSource(job: Job<any>): Promise<void> {
    const { sourceId, url, scraperType } = job.data;

    try {
      this.logger.log(`Scraping source: ${sourceId} - ${url}`);

      await this.postgresService.query(
        `UPDATE scraping_sources SET last_run_at = NOW(), status = 'running' WHERE id = $1`,
        [sourceId],
      );

      // Fetch the main page
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; LexiaBot/1.0; +https://lexia.ma)',
          Accept: 'text/html,application/xhtml+xml',
        },
        maxRedirects: 5,
      });

      const html = response.data as string;
      const timestamp = Date.now();
      const pageKey = `${sourceId}/${timestamp}-index.html`;

      // Save raw HTML to MinIO
      await this.minioService.uploadFile(
        'scraped-html',
        pageKey,
        Buffer.from(html, 'utf-8'),
        Buffer.byteLength(html, 'utf-8'),
        'text/html',
      );

      // Parse links for further scraping
      const links = this.extractLinks(html, url);
      this.logger.log(`Found ${links.length} links on ${url}`);

      let processedCount = 0;
      for (const link of links.slice(0, 50)) { // limit per run
        try {
          const pageResp = await axios.get(link, {
            timeout: 20000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; LexiaBot/1.0)',
            },
          });

          const pageHtml = pageResp.data as string;
          const pageKey = `${sourceId}/${timestamp}-page-${processedCount}.html`;

          await this.minioService.uploadFile(
            'scraped-html',
            pageKey,
            Buffer.from(pageHtml, 'utf-8'),
            Buffer.byteLength(pageHtml, 'utf-8'),
            'text/html',
          );

          // Enqueue for document processing if it looks like a document
          if (this.isLegalDocument(pageHtml)) {
            await this.docQueue.add('process-document', {
              documentId: `scraped-${sourceId}-${processedCount}`,
              bucket: 'scraped-html',
              key: pageKey,
              ownerType: 'system',
              sourceUrl: link,
            });
          }

          processedCount++;

          // Rate limiting
          await new Promise((r) => setTimeout(r, 1000));
        } catch (pageErr) {
          this.logger.warn(`Failed to scrape page ${link}: ${pageErr.message}`);
        }
      }

      await this.postgresService.query(
        `UPDATE scraping_sources SET
           last_run_at = NOW(),
           status = 'idle',
           pages_scraped = pages_scraped + $1
         WHERE id = $2`,
        [processedCount, sourceId],
      );

      this.logger.log(`Scraping complete for ${sourceId}: ${processedCount} pages`);
    } catch (err) {
      this.logger.error(`Scraping failed for ${sourceId}: ${err.message}`);
      await this.postgresService.query(
        `UPDATE scraping_sources SET status = 'error', last_error = $1 WHERE id = $2`,
        [err.message, sourceId],
      );
      throw err;
    }
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
        // Only follow same-domain links
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
}
