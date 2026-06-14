import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { BaseScraper, ScrapedPage } from './base.scraper';

@Injectable()
export class AdalaScraper extends BaseScraper {
  private readonly logger = new Logger(AdalaScraper.name);
  private readonly baseUrl = 'https://adala.justice.gov.ma';

  async scrape(source: { url?: string; maxPages?: number }): Promise<ScrapedPage[]> {
    const startUrl = source?.url || `${this.baseUrl}/ar/content/jurisprudence.aspx`;
    const maxPages = source?.maxPages || 20;
    const results: ScrapedPage[] = [];

    try {
      const indexHtml = await this.fetchHtml(startUrl);
      const links = this.parseLinks(indexHtml, startUrl).filter((l) =>
        this.isJudgmentLink(l),
      );

      this.logger.log(`Adala: Found ${links.length} judgment links`);

      for (const link of links.slice(0, maxPages)) {
        try {
          const html = await this.fetchHtml(link);
          const page = this.parseJudgmentPage(html, link);
          if (page && page.content.length > 200) {
            results.push(page);
          }
          await this.sleep(2000);
        } catch (err) {
          this.logger.warn(`Adala: Failed to scrape ${link}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Adala scraper failed: ${err.message}`);
    }

    return results;
  }

  private isJudgmentLink(url: string): boolean {
    return (
      url.includes('adala.justice.gov.ma') &&
      (url.includes('jurisprudence') ||
        url.includes('decision') ||
        url.includes('jugement') ||
        url.includes('arret') ||
        url.includes('content'))
    );
  }

  private parseJudgmentPage(html: string, url: string): ScrapedPage | null {
    const $ = cheerio.load(html);

    let title = '';
    let content = '';

    // Adala uses ASP.NET webforms
    title =
      $('.ContentTitle, .page-title, h1, #lblTitle').first().text().trim() ||
      $('title').text().trim();

    const contentSelectors = [
      '#ContentPlaceHolder1_Panel1',
      '.ContentBody',
      '#lblContent',
      '.judgment-body',
      '#content',
      'article',
      '.article-content',
    ];

    for (const sel of contentSelectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 200) {
        content = el.text().trim().replace(/\s+/g, ' ');
        break;
      }
    }

    if (!content) {
      // Fallback to body text
      $('script, style, nav, header, footer').remove();
      content = $('body').text().trim().replace(/\s+/g, ' ');
    }

    const arabicPattern = /[؀-ۿ]/;
    if (!arabicPattern.test(content)) return null;

    return { url, title, content };
  }
}
