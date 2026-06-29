import axios from 'axios';
import * as cheerio from 'cheerio';

export interface ScrapedPage {
  url: string;
  content: string;
  title: string;
  mimeType?: string;
  binary?: Buffer;
  metadata?: Record<string, unknown>;
}

export abstract class BaseScraper {
  protected readonly defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; LexiaBot/1.0; +https://lexia.ma)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ar,fr;q=0.9,en;q=0.8',
  };

  abstract scrape(source: any): Promise<ScrapedPage[]>;

  protected async fetchHtml(url: string): Promise<string> {
    const response = await axios.get(url, {
      headers: this.defaultHeaders,
      timeout: 30000,
      maxRedirects: 5,
    });
    return response.data as string;
  }

  protected parseLinks(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);
    const links: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const fullUrl = new URL(href, baseUrl);
        if (fullUrl.hostname === base.hostname) {
          links.push(fullUrl.toString());
        }
      } catch {
        // skip invalid
      }
    });

    return [...new Set(links)];
  }

  protected extractText($: cheerio.CheerioAPI, selector: string): string {
    return $(selector).text().trim().replace(/\s+/g, ' ');
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
