import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { BaseScraper, ScrapedPage } from './base.scraper';

@Injectable()
export class SggScraper extends BaseScraper {
  private readonly logger = new Logger(SggScraper.name);
  private readonly baseUrl = 'https://www.sgg.gov.ma';

  async scrape(source: { url?: string; maxPages?: number }): Promise<ScrapedPage[]> {
    const startUrl = source?.url || `${this.baseUrl}/ar/legislation.html`;
    const maxPages = source?.maxPages || 20;
    const results: ScrapedPage[] = [];

    try {
      const indexHtml = await this.fetchHtml(startUrl);
      const links = this.parseLinks(indexHtml, startUrl).filter((l) =>
        this.isLegalLink(l),
      );

      this.logger.log(`SGG: Found ${links.length} legal links`);

      for (const link of links.slice(0, maxPages)) {
        try {
          const html = await this.fetchHtml(link);
          const page = this.parseLegalPage(html, link);
          if (page && page.content.length > 200) {
            results.push(page);
          }
          await this.sleep(1500);
        } catch (err) {
          this.logger.warn(`SGG: Failed to scrape ${link}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`SGG scraper failed: ${err.message}`);
    }

    return results;
  }

  private isLegalLink(url: string): boolean {
    return (
      url.includes('/ar/') &&
      (url.includes('legislation') ||
        url.includes('dahir') ||
        url.includes('decret') ||
        url.includes('loi') ||
        url.includes('قانون') ||
        url.includes('ظهير'))
    );
  }

  private parseLegalPage(html: string, url: string): ScrapedPage | null {
    const $ = cheerio.load(html);

    // Try common selectors for SGG
    let title = '';
    let content = '';

    // Try Arabic title
    title =
      $('h1.ar, .page-title-ar, [lang="ar"] h1').first().text().trim() ||
      $('h1').first().text().trim() ||
      $('title').text().trim();

    // Extract main content — SGG uses various content containers
    const contentSelectors = [
      '.field-item',
      '.node-content',
      '#content-area',
      'article',
      '.content',
      'main',
    ];

    for (const sel of contentSelectors) {
      const text = $(sel).text().trim();
      if (text.length > 200) {
        content = text;
        break;
      }
    }

    if (!content) {
      content = $('body').text().trim().replace(/\s+/g, ' ');
    }

    // Filter only Arabic legal content
    const arabicPattern = /[؀-ۿ]/;
    if (!arabicPattern.test(content)) return null;

    return { url, title, content };
  }
}
