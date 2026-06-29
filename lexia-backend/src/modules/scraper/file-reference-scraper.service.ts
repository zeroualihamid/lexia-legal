import { Injectable, Logger } from '@nestjs/common';
import { MahakimService } from '../mahakim/mahakim.service';
import { JuriscassationScraper } from './juriscassation.scraper';
import {
  ScrapeByFileReferenceOptions,
  ScrapeByFileReferenceResult,
} from './file-reference.types';
import {
  buildDocumentTitle,
  defaultCspjSubject,
  parseFileReference,
  preferredSourceOrder,
} from './file-reference.util';
import { ScrapedPage } from './base.scraper';

@Injectable()
export class FileReferenceScraperService {
  private readonly logger = new Logger(FileReferenceScraperService.name);

  constructor(
    private readonly mahakim: MahakimService,
    private readonly juriscassation: JuriscassationScraper,
  ) {}

  /**
   * Scrape a judgment by file reference.
   * Appeal refs (YEAR/CODE/NUM) → mahakim.ma first, CSPJ fallback.
   * Cassation refs (YEAR/CH/PANEL/NUM) → CSPJ only.
   */
  async scrape(
    options: ScrapeByFileReferenceOptions,
  ): Promise<ScrapeByFileReferenceResult> {
    const parsed = parseFileReference(options.fileReference);
    if (!parsed.raw) {
      return {
        fileReference: options.fileReference,
        format: 'unknown',
        source: 'none',
        found: false,
        message: 'مرجع الملف فارغ أو غير صالح',
      };
    }

    const order = preferredSourceOrder(parsed.format);
    this.logger.log(
      `Scrape by ref ${parsed.raw} format=${parsed.format} order=${order.join('→')}`,
    );

    for (const source of order) {
      if (source === 'mahakim') {
        const mahakimResult = await this.tryMahakim(parsed, options);
        if (mahakimResult.found) return mahakimResult;
      }
      if (source === 'juriscassation') {
        const cspjResult = await this.tryJuriscassation(parsed, options);
        if (cspjResult.found) return cspjResult;
      }
    }

    return {
      fileReference: parsed.raw,
      format: parsed.format,
      source: 'none',
      found: false,
      message:
        'لم يتم العثور على قرار لهذا المرجع على mahakim.ma ولا juriscassation.cspj.ma',
    };
  }

  /** Convert scrape result to ScrapedPage[] for the existing ingest pipeline. */
  toScrapedPages(result: ScrapeByFileReferenceResult): ScrapedPage[] {
    if (!result.found) return [];

    if (result.pdf) {
      return [
        {
          url: result.pdfUrl || result.fileReference,
          title: result.title || `ملف ${result.fileReference}`,
          content: '',
          mimeType: 'application/pdf',
          binary: result.pdf,
        },
      ];
    }

    const text =
      result.mahakim?.text ||
      JSON.stringify(result.metadata || {}, null, 2);
    return [
      {
        url: `mahakim://${result.fileReference}`,
        title: result.title || `ملف ${result.fileReference}`,
        content: text,
        mimeType: 'text/plain',
      },
    ];
  }

  private async tryMahakim(
    parsed: ReturnType<typeof parseFileReference>,
    options: ScrapeByFileReferenceOptions,
  ): Promise<ScrapeByFileReferenceResult> {
    if (!parsed.mahakim) {
      return {
        fileReference: parsed.raw,
        format: parsed.format,
        source: 'mahakim',
        found: false,
        message: 'تنسيق المرجع غير مناسب لـ mahakim.ma',
      };
    }

    try {
      const mahakimResult = await this.mahakim.fetchCaseAuto({
        fileNumber: parsed.mahakim.fileNumber,
        fileCode: parsed.mahakim.fileCode,
        fileYear: parsed.mahakim.fileYear,
        courtName: options.courtName,
        courtType: options.courtType === 'first_instance' ? 'first_instance' : 'appeal',
        category: 'file',
      });

      if (!mahakimResult.found) {
        return {
          fileReference: parsed.raw,
          format: parsed.format,
          source: 'mahakim',
          found: false,
          mahakim: mahakimResult,
          message: mahakimResult.message || 'لا توجد نتيجة على mahakim.ma',
        };
      }

      const card = this.mahakim.parseFileCard(mahakimResult.text);
      const title = buildDocumentTitle(parsed, {
        decisionNumber: card['رقم آخر حكم / القرار'] || card['آخر حكم/قرار'],
        decisionDate: card['تاريخ آخر حكم / القرار'],
        courtName: card['المحكمة'] || mahakimResult.query.courtName,
      });

      return {
        fileReference: parsed.raw,
        format: parsed.format,
        source: 'mahakim',
        found: true,
        title,
        mahakim: mahakimResult,
        metadata: {
          fileReference: parsed.raw,
          mahakim: card,
          reportingJudge: card['المستشار / القاضي المقرر'],
          nationalFileNumber: card['الرقم الوطني للملف'],
          caseType: card['نوع الملف'],
          subject: card['الموضوع'],
          triedCourts: mahakimResult.triedCourts,
        },
        message: 'تم العثور على الملف عبر mahakim.ma (بدون PDF عام)',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Mahakim scrape failed for ${parsed.raw}: ${message}`);
      return {
        fileReference: parsed.raw,
        format: parsed.format,
        source: 'mahakim',
        found: false,
        message,
      };
    }
  }

  private async tryJuriscassation(
    parsed: ReturnType<typeof parseFileReference>,
    options: ScrapeByFileReferenceOptions,
  ): Promise<ScrapeByFileReferenceResult> {
    try {
      const pages = await this.juriscassation.scrapeByFileReference({
        fileReference: parsed.cspjQuery || parsed.raw,
        locale: options.locale,
        searchSubject: options.searchSubject || defaultCspjSubject(parsed),
      });

      if (!pages.length) {
        return {
          fileReference: parsed.raw,
          format: parsed.format,
          source: 'juriscassation',
          found: false,
          message: 'لا توجد نتيجة على juriscassation.cspj.ma',
        };
      }

      const page = pages[0];
      return {
        fileReference: parsed.raw,
        format: parsed.format,
        source: 'juriscassation',
        found: true,
        title: page.title,
        pdf: page.binary,
        pdfUrl: page.url,
        metadata: { fileReference: parsed.raw, source: 'juriscassation' },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`CSPJ scrape failed for ${parsed.raw}: ${message}`);
      return {
        fileReference: parsed.raw,
        format: parsed.format,
        source: 'juriscassation',
        found: false,
        message,
      };
    }
  }
}
