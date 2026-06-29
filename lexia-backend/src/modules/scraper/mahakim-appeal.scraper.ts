import { Injectable, Logger } from '@nestjs/common';
import { BaseScraper, ScrapedPage } from './base.scraper';
import { MahakimService } from '../mahakim/mahakim.service';
import { parseFileReference, buildDocumentTitle } from './file-reference.util';

/** Default: محكمة الاستئناف التجارية بالدار البيضاء (mark 8221). */
export const DEFAULT_COMMERCIAL_APPEAL_COURT =
  'محكمة الاستئناف التجارية بالدار البيضاء';
export const DEFAULT_COMMERCIAL_APPEAL_CODE = '8221';

export interface MahakimAppealScrapeOptions {
  maxDownloads?: number;
  courtName?: string;
  fileCode?: string;
  /** Explicit appeal refs: YEAR/CODE/NUMBER */
  fileReferences?: string[];
  /** Discovery scan when fileReferences is empty. */
  fileYears?: number[];
  fileNumberStart?: number;
  fileNumberEnd?: number;
}

@Injectable()
export class MahakimAppealScraper extends BaseScraper {
  private readonly logger = new Logger(MahakimAppealScraper.name);

  constructor(private readonly mahakim: MahakimService) {
    super();
  }

  async scrape(source: MahakimAppealScrapeOptions = {}): Promise<ScrapedPage[]> {
    const maxDownloads = source.maxDownloads || 10;
    const courtName = source.courtName || DEFAULT_COMMERCIAL_APPEAL_COURT;
    const fileCode = source.fileCode || DEFAULT_COMMERCIAL_APPEAL_CODE;
    const results: ScrapedPage[] = [];
    const seenRefs = new Set<string>();

    const explicit = (source.fileReferences || []).map((r) => r.trim()).filter(Boolean);
    if (explicit.length) {
      for (const ref of explicit) {
        if (results.length >= maxDownloads) break;
        const page = await this.scrapeReference(ref, courtName);
        if (page && !seenRefs.has(ref)) {
          seenRefs.add(ref);
          results.push(page);
        }
      }
      return results;
    }

    const years = source.fileYears || [2023, 2022, 2021, 2020, 2019, 2018, 2017];
    const start = source.fileNumberStart ?? 4700;
    const end = source.fileNumberEnd ?? 5200;

    this.logger.log(
      `Mahakim appeal: court="${courtName}" code=${fileCode} years=${years.join(',')} nums=${start}..${end} max=${maxDownloads}`,
    );

    outer: for (const year of years) {
      for (let num = start; num <= end; num++) {
        if (results.length >= maxDownloads) break outer;
        const ref = `${year}/${fileCode}/${num}`;
        if (seenRefs.has(ref)) continue;

        const page = await this.scrapeReference(ref, courtName, fileCode);
        if (page) {
          seenRefs.add(ref);
          results.push(page);
          this.logger.log(`Mahakim appeal: found ${ref} (${results.length}/${maxDownloads})`);
        }
        await this.sleep(300);
      }
    }

    this.logger.log(`Mahakim appeal: ${results.length} dossier(s) trouvé(s)`);
    return results;
  }

  private async scrapeReference(
    fileReference: string,
    courtName: string,
    fileCode?: string,
  ): Promise<ScrapedPage | null> {
    const parsed = parseFileReference(fileReference);
    if (!parsed.mahakim) return null;

    try {
      const result = courtName
        ? await this.mahakim.fetchCase({
            fileNumber: parsed.mahakim.fileNumber,
            fileCode: fileCode || parsed.mahakim.fileCode,
            fileYear: parsed.mahakim.fileYear,
            courtName,
            courtType: 'appeal',
            category: 'file',
          })
        : await this.mahakim.fetchCaseAuto({
            fileNumber: parsed.mahakim.fileNumber,
            fileCode: fileCode || parsed.mahakim.fileCode,
            fileYear: parsed.mahakim.fileYear,
            courtName,
            courtType: 'appeal',
            category: 'file',
          });

      if (!result.found) return null;

      const card = this.mahakim.parseFileCard(result.text);
      const title = buildDocumentTitle(parsed, {
        decisionNumber: card['رقم آخر حكم / القرار'] || card['آخر حكم/قرar'],
        decisionDate: card['تاريخ آخر حكم / القرار'],
        courtName: card['المحكمة'] || courtName,
      });

      const body = [
        `مرجع الملف: ${parsed.raw}`,
        `المحكمة: ${card['المحكمة'] || courtName}`,
        `رقم الملف بالمحكمة: ${card['رقم الملف بالمحكمة'] || parsed.raw}`,
        `الرقم الوطني: ${card['الرقم الوطني للملف'] || ''}`,
        `نوع الملف: ${card['نوع الملف'] || ''}`,
        `الموضوع: ${card['الموضوع'] || ''}`,
        `آخر قرار: ${card['رقم آخر حكم / القرار'] || card['آخر حكم/قرar'] || ''}`,
        `تاريخ القرار: ${card['تاريخ آخر حكم / القرار'] || ''}`,
        `المستشار المقرر: ${card['المستشار / القاضي المقرر'] || ''}`,
        '',
        '--- نص الصفحة ---',
        result.text,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        url: `mahakim://${parsed.raw}`,
        title,
        content: body,
        mimeType: 'text/plain',
        metadata: {
          fileReference: parsed.raw,
          courtLevel: 'appeal',
          courtName: card['المحكمة'] || courtName,
          mahakim: card,
          scrapeSource: 'mahakim',
        },
      } as ScrapedPage & { metadata?: Record<string, unknown> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Mahakim appeal: failed ${fileReference}: ${message}`);
      return null;
    }
  }
}
