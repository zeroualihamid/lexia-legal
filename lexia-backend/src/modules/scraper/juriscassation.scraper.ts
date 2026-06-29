import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as https from 'https';
import { BaseScraper, ScrapedPage } from './base.scraper';

const BASE_URL = 'https://juriscassation.cspj.ma';
const DEFAULT_SEARCH_SUBJECT = 'تأمين';

export interface JuriscassationScrapeOptions {
  url?: string;
  maxPages?: number;
  maxDownloads?: number;
  locale?: 'ar' | 'en' | 'fr';
  startPage?: number;
  /** Required search keyword on the CSPJ portal (min 3 Arabic chars). */
  searchSubject?: string;
  /** When set, search by ملف number (NumeroDos) instead of subject-only browse. */
  fileReference?: string;
}

interface DecisionRow {
  encryptedId: string;
  fileNumber: string;
  decisionNumber: string;
  decisionDate: string;
  title: string;
}

@Injectable()
export class JuriscassationScraper extends BaseScraper {
  private readonly logger = new Logger(JuriscassationScraper.name);

  private createSession(): AxiosInstance {
    return axios.create({
      timeout: 45000,
      maxRedirects: 5,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        ...this.defaultHeaders,
        Accept: '*/*',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
  }

  async scrape(source: JuriscassationScrapeOptions = {}): Promise<ScrapedPage[]> {
    const locale = this.resolveLocale(source);
    const startPage = Math.max(1, source.startPage || 1);
    const maxPages = source.maxPages || 10;
    const maxDownloads = source.maxDownloads || 100;
    const searchSubject = (source.searchSubject || DEFAULT_SEARCH_SUBJECT).trim();
    const results: ScrapedPage[] = [];
    const seenIds = new Set<string>();

    const client = this.createSession();
    await this.bootstrapSearchSession(client, locale);

    this.logger.log(
      `Juriscassation: subject="${searchSubject}" locale=${locale} pages ${startPage}..${startPage + maxPages - 1} max=${maxDownloads}`,
    );

    for (let page = startPage; page < startPage + maxPages; page++) {
      if (results.length >= maxDownloads) break;

      let rows: DecisionRow[] = [];
      try {
        rows = await this.fetchDecisionRows(client, locale, page, searchSubject);
        this.logger.log(`Juriscassation: page ${page} → ${rows.length} décision(s)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Juriscassation: page ${page} failed: ${message}`);
        if (page === startPage) {
          throw new Error(
            `Impossible d'accéder à juriscassation.cspj.ma (${message}). ` +
              'Le portail exige une recherche par موضوع et peut être inaccessible hors Maroc.',
          );
        }
        break;
      }

      if (!rows.length) break;

      for (const row of rows) {
        if (results.length >= maxDownloads) break;
        if (seenIds.has(row.encryptedId)) continue;
        seenIds.add(row.encryptedId);

        try {
          const pdfUrl = `${BASE_URL}/Decisions/GetArret?encryptedId=${encodeURIComponent(row.encryptedId)}`;
          const pdf = await this.downloadPdf(client, pdfUrl);
          if (pdf.length < 500) {
            this.logger.warn(`Juriscassation: PDF trop petit, ignoré: ${row.title}`);
            continue;
          }
          results.push({
            url: pdfUrl,
            title: row.title,
            content: '',
            mimeType: 'application/pdf',
            binary: pdf,
          });
          await this.sleep(900);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Juriscassation: échec PDF ${row.title}: ${message}`);
        }
      }

      await this.sleep(1200);
    }

    this.logger.log(`Juriscassation: ${results.length} PDF(s) téléchargé(s)`);
    return results;
  }

  /** Search CSPJ by cassation file reference and download the matching PDF. */
  async scrapeByFileReference(opts: {
    fileReference: string;
    locale?: 'ar' | 'en' | 'fr';
    searchSubject?: string;
  }): Promise<ScrapedPage[]> {
    const locale = opts.locale || 'ar';
    const fileReference = (opts.fileReference || '').trim();
    const searchSubject = (opts.searchSubject || 'قانون').trim();
    if (!fileReference) return [];

    const client = this.createSession();
    await this.bootstrapSearchSession(client, locale);

    const formHtml = await this.fetchSearchFormHtml(client, locale);
    const body = this.buildSearchBody(formHtml, searchSubject, fileReference);

    const url = `${BASE_URL}/${locale}/Decisions/RechercheDecisionsRes?page=1`;
    const response = await client.post(url, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    const norm = (s: string) => s.replace(/\s+/g, '').trim();
    const target = norm(fileReference);
    const rows = this.parseDecisionRows(response.data as string).filter((row) => {
      const file = norm(row.fileNumber);
      return file === target || file.includes(target) || target.includes(file);
    });

    if (!rows.length) {
      this.logger.log(`Juriscassation: no row for file ref ${fileReference}`);
      return [];
    }

    const row = rows[0];
    const pdfUrl = `${BASE_URL}/Decisions/GetArret?encryptedId=${encodeURIComponent(row.encryptedId)}`;
    const pdf = await this.downloadPdf(client, pdfUrl);
    if (pdf.length < 500) {
      this.logger.warn(`Juriscassation: PDF too small for ${fileReference}`);
      return [];
    }

    return [
      {
        url: pdfUrl,
        title: row.title,
        content: '',
        mimeType: 'application/pdf',
        binary: pdf,
      },
    ];
  }

  resolveLocale(source: JuriscassationScrapeOptions): 'ar' | 'en' | 'fr' {
    if (source.locale) return source.locale;
    const url = source.url || '';
    const match = url.match(/juriscassation\.cspj\.ma\/(ar|en|fr)\//i);
    if (match) return match[1].toLowerCase() as 'ar' | 'en' | 'fr';
    return 'ar';
  }

  /** Load the search form so anti-forgery cookies are established. */
  private async bootstrapSearchSession(
    client: AxiosInstance,
    locale: string,
  ): Promise<void> {
    await client.get(`${BASE_URL}/${locale}/Decisions/RechercheDecisions`);
  }

  async fetchDecisionRows(
    client: AxiosInstance,
    locale: string,
    page: number,
    searchSubject: string,
  ): Promise<DecisionRow[]> {
    const formHtml = await this.fetchSearchFormHtml(client, locale);
    const body = this.buildSearchBody(formHtml, searchSubject);

    const url = `${BASE_URL}/${locale}/Decisions/RechercheDecisionsRes?page=${page}`;
    const response = await client.post(url, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    return this.parseDecisionRows(response.data as string);
  }

  /** Backward-compatible helper used in tests. */
  parseDecisionLinks(html: string): Array<{ pdfUrl: string; title: string }> {
    return this.parseDecisionRows(html).map((row) => ({
      pdfUrl: `${BASE_URL}/Decisions/GetArret?encryptedId=${encodeURIComponent(row.encryptedId)}`,
      title: row.title,
    }));
  }

  private async fetchSearchFormHtml(
    client: AxiosInstance,
    locale: string,
  ): Promise<string> {
    const response = await client.get(
      `${BASE_URL}/${locale}/Decisions/RechercheDecisions`,
    );
    return response.data as string;
  }

  private buildSearchBody(
    formHtml: string,
    searchSubject: string,
    fileReference?: string,
  ): string {
    const $ = cheerio.load(formHtml);
    const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
    const roomIds = $('select[name="ChambreIds"] option')
      .map((_, el) => $(el).attr('value'))
      .get()
      .filter(Boolean);

    const params = new URLSearchParams();
    params.append('__RequestVerificationToken', token);
    params.append('NumeroDos', fileReference || '');
    params.append('NumeroDec', '');
    params.append('DateDec', '');
    for (const id of roomIds) params.append('ChambreIds', id);
    params.append('DecisionPriseParId', '1');
    params.append('Sujet', searchSubject);
    return params.toString();
  }

  private parseDecisionRows(html: string): DecisionRow[] {
    const $ = cheerio.load(html);
    const rows: DecisionRow[] = [];

    $('#myid tbody tr').each((_, tr) => {
      const cells = $(tr).find('td');
      const btn = $(tr).find('.show-modal-btn');
      const encryptedId = btn.attr('data-id');
      if (!encryptedId) return;

      const fileNumber = cells.eq(0).text().trim().replace(/\s+/g, ' ');
      const decisionNumber = cells.eq(1).text().trim().replace(/\s+/g, ' ');
      const decisionDate = cells.eq(2).text().trim().replace(/\s+/g, ' ');
      const title = [
        fileNumber && `ملف ${fileNumber}`,
        decisionNumber && `قرار ${decisionNumber}`,
        decisionDate,
      ]
        .filter(Boolean)
        .join(' — ');

      rows.push({
        encryptedId,
        fileNumber,
        decisionNumber,
        decisionDate,
        title: title || `قرار محكمة النقض ${decisionNumber || fileNumber}`,
      });
    });

    return rows;
  }

  private async downloadPdf(client: AxiosInstance, url: string): Promise<Buffer> {
    const response = await client.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Accept: 'application/pdf,*/*',
      },
    });
    return Buffer.from(response.data);
  }
}
