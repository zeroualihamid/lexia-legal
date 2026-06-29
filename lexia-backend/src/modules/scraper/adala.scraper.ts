import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { BaseScraper, ScrapedPage } from './base.scraper';
import { JuriscassationScraper } from './juriscassation.scraper';

const BASE_URL = 'https://adala.justice.gov.ma';

/** Known Adala resource IDs (see /api/files/resources). */
const RESOURCE_IDS = {
  legalTexts: 1,
  documentation: 148,
  lawJournal: 1078,
  circulars: 280,
  royalSpeeches: 331,
} as const;

export interface AdalaScrapeOptions {
  url?: string;
  maxPages?: number;
  maxDownloads?: number;
  fileRessourceId?: number;
  folderId?: number;
}

interface AdalaFileItem {
  id: number;
  name: string;
  path: string;
  type: string;
}

interface AdalaSearchResponse {
  meta: {
    totalItems: number;
    totalPages: number;
    itemsPerPage: number;
    currentPage: number;
  };
  items: {
    results: Array<{
      type: string;
      name: string;
      path: string;
      fileMeta?: Record<string, unknown>;
    }>;
  };
}

@Injectable()
export class AdalaScraper extends BaseScraper {
  private readonly logger = new Logger(AdalaScraper.name);

  constructor(private readonly juriscassationScraper: JuriscassationScraper) {
    super();
  }

  async scrape(source: AdalaScrapeOptions = {}): Promise<ScrapedPage[]> {
    const target = this.resolveTarget(source);

    if (target.mode === 'juriscassation') {
      this.logger.log(
        'Adala: /resources/Jurisprudence redirige vers juriscassation.cspj.ma (CSPJ)',
      );
      return this.juriscassationScraper.scrape({
        url: target.url,
        maxPages: source.maxPages || 10,
        maxDownloads: source.maxDownloads || source.maxPages || 50,
        searchSubject: (source as any).searchSubject,
      });
    }

    const maxDownloads = source.maxDownloads || source.maxPages || 20;
    const client = this.createClient();
    const files = await this.collectFiles(client, target, maxDownloads);

    this.logger.log(`Adala: ${files.length} fichier(s) PDF à télécharger`);

    const results: ScrapedPage[] = [];
    for (const file of files.slice(0, maxDownloads)) {
      try {
        const pdf = await this.downloadPdf(client, file.path);
        if (pdf.length < 500) {
          this.logger.warn(`Adala: PDF trop petit, ignoré: ${file.name}`);
          continue;
        }
        results.push({
          url: `${BASE_URL}/api/${file.path}`,
          title: file.name,
          content: '',
          mimeType: 'application/pdf',
          binary: pdf,
        });
        await this.sleep(800);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Adala: échec PDF ${file.name}: ${message}`);
      }
    }

    this.logger.log(`Adala: ${results.length} PDF(s) téléchargé(s)`);
    return results;
  }

  private createClient(): AxiosInstance {
    return axios.create({
      timeout: 120000,
      maxRedirects: 5,
      headers: {
        ...this.defaultHeaders,
        Accept: 'application/json, application/pdf, */*',
        Referer: `${BASE_URL}/resources`,
      },
      maxContentLength: 250 * 1024 * 1024,
      maxBodyLength: 250 * 1024 * 1024,
    });
  }

  private resolveTarget(
    source: AdalaScrapeOptions,
  ):
    | { mode: 'juriscassation'; url: string }
    | { mode: 'api'; folderId?: number; fileRessourceId?: number } {
    const url = (source.url || '').trim();

    if (this.isJurisprudenceUrl(url)) {
      return { mode: 'juriscassation', url: 'https://juriscassation.cspj.ma/ar' };
    }

    if (source.folderId) {
      return { mode: 'api', folderId: source.folderId, fileRessourceId: source.fileRessourceId };
    }

    if (source.fileRessourceId) {
      return { mode: 'api', fileRessourceId: source.fileRessourceId };
    }

    const folderMatch = url.match(/adala\.justice\.gov\.ma\/resources\/(\d+)/i);
    if (folderMatch) {
      return { mode: 'api', folderId: Number(folderMatch[1]) };
    }

    const resourceIdMatch = url.match(/[?&]fileRessourceId=(\d+)/i);
    if (resourceIdMatch) {
      return { mode: 'api', fileRessourceId: Number(resourceIdMatch[1]) };
    }

    // Default: مجلة القضاء والقانون (closest judgment-related corpus still hosted on Adala)
    return { mode: 'api', fileRessourceId: RESOURCE_IDS.lawJournal };
  }

  private isJurisprudenceUrl(url: string): boolean {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      /\/resources\/jurisprudence\b/i.test(url) ||
      /[?&]resource=jurisprudence\b/i.test(lower) ||
      lower.includes('/jurisprudence')
    );
  }

  private async collectFiles(
    client: AxiosInstance,
    target: { folderId?: number; fileRessourceId?: number },
    limit: number,
  ): Promise<AdalaFileItem[]> {
    if (target.folderId) {
      return this.fetchFolderFiles(client, target.folderId, limit);
    }

    return this.searchFiles(client, target.fileRessourceId || RESOURCE_IDS.lawJournal, limit);
  }

  private async fetchFolderFiles(
    client: AxiosInstance,
    folderId: number,
    limit: number,
  ): Promise<AdalaFileItem[]> {
    const response = await client.get(`${BASE_URL}/api/folders/${folderId}`);
    const files: AdalaFileItem[] = (response.data?.files || []).filter(
      (f: AdalaFileItem) => f.type === 'PDF' && f.path,
    );

    this.logger.log(`Adala: dossier ${folderId} → ${files.length} PDF(s)`);
    return files.slice(0, limit);
  }

  private async searchFiles(
    client: AxiosInstance,
    fileRessourceId: number,
    limit: number,
  ): Promise<AdalaFileItem[]> {
    const perPage = Math.min(50, limit);
    const files: AdalaFileItem[] = [];
    let page = 1;

    while (files.length < limit) {
      const response = await client.get<AdalaSearchResponse>(`${BASE_URL}/api/files/search`, {
        params: {
          page,
          perPage,
          fileRessourceId,
        },
      });

      const batch = (response.data?.items?.results || [])
        .filter((item) => item.type === 'PDF' && item.path)
        .map((item, index) => ({
          id: page * 1000 + index,
          name: item.name,
          path: item.path,
          type: 'PDF',
        }));

      if (!batch.length) break;

      files.push(...batch);
      this.logger.log(
        `Adala: recherche resource=${fileRessourceId} page ${page} → ${batch.length} PDF(s)`,
      );

      const totalPages = response.data?.meta?.totalPages || 1;
      if (page >= totalPages) break;
      page += 1;
      await this.sleep(500);
    }

    return files.slice(0, limit);
  }

  private async downloadPdf(client: AxiosInstance, path: string): Promise<Buffer> {
    const encodedPath = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const response = await client.get(`${BASE_URL}/api/${encodedPath}`, {
      responseType: 'arraybuffer',
      headers: {
        Accept: 'application/pdf,*/*',
        Referer: `${BASE_URL}/resources`,
      },
    });

    return Buffer.from(response.data);
  }
}
