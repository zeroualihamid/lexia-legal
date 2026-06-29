import { Injectable, Logger } from '@nestjs/common';
import { ClaudeCodeService } from '../../common/claude/claude-code.service';
import { parseReferenceFromText } from '../cases/cases.service';
import {
  JudgmentFileReference,
  JudgmentMetadata,
  JudgmentParties,
} from './judgment-metadata.types';

@Injectable()
export class JudgmentMetadataService {
  private readonly logger = new Logger(JudgmentMetadataService.name);

  constructor(private readonly claudeCode: ClaudeCodeService) {}

  /**
   * Extract structured judgment header metadata from OCR text: file reference,
   * bench judges, and opposing parties.
   */
  async extractFromText(text: string): Promise<JudgmentMetadata> {
    const header = text.slice(0, 12000);
    const regexMeta = this.extractWithRegex(header);

    if (!this.claudeCode.isAvailable()) {
      return { ...regexMeta, source: 'regex' };
    }

    try {
      const claudeMeta = await this.claudeCode.invokeJson<{
        fileReference?: JudgmentFileReference;
        judges?: string[];
        parties?: Partial<JudgmentParties>;
        lawyers?: string[];
      }>(
        `You extract structured metadata from Moroccan court judgments (Arabic/French).
Return JSON only (no markdown):
{
  "fileReference": {
    "fileReferenceRaw": "composite file ref e.g. 2025/1/3/599 or null",
    "fileNumber": "numeric file part or null",
    "fileCode": "file mark/code or null",
    "fileYear": "4-digit year or null",
    "decisionNumber": "decision number or null",
    "decisionDate": "YYYY-MM-DD or null",
    "courtName": "full court name in Arabic or null",
    "courtSection": "chamber/section e.g. الغرفة التجارية or null",
    "courtPanel": "panel/bench e.g. الهيئة الأولى or null",
    "courtType": "cassation|appeal|first_instance or null",
    "appealedFileReference": "lower court file ref in cassation appeals or null"
  },
  "judges": ["judge full names only, no titles"],
  "parties": {
    "plaintiffs": ["party names — companies/persons, not lawyers"],
    "defendants": ["party names"],
    "others": ["interveners/third parties if any"]
  },
  "lawyers": ["lawyer names representing parties"]
}
Rules:
- Distinguish parties (الطالبة/المستأنف/المدعي) from lawyers (المحامي/النائب).
- Include cassation reporting judge (المستشار المفرز) in judges[].
- Do not invent data absent from the text.

Judgment text (header):

${header}`,
        { label: 'judgment-metadata' },
      );

      if (!claudeMeta) {
        return { ...regexMeta, source: 'regex' };
      }

      return this.mergeMetadata(regexMeta, claudeMeta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Claude judgment metadata failed: ${message}`);
      return { ...regexMeta, source: 'regex' };
    }
  }

  private mergeMetadata(
    regex: Omit<JudgmentMetadata, 'source'>,
    claude: {
      fileReference?: JudgmentFileReference;
      judges?: string[];
      parties?: Partial<JudgmentParties>;
      lawyers?: string[];
    },
  ): JudgmentMetadata {
    const fileReference: JudgmentFileReference = {
      ...regex.fileReference,
      ...(claude.fileReference || {}),
    };
    for (const key of Object.keys(fileReference) as (keyof JudgmentFileReference)[]) {
      if (fileReference[key] == null && regex.fileReference[key] != null) {
        fileReference[key] = regex.fileReference[key];
      }
    }

    const judges = this.uniqueNames([
      ...(claude.judges || []),
      ...regex.judges,
    ]);

    const parties: JudgmentParties = {
      plaintiffs: this.uniqueNames([
        ...(claude.parties?.plaintiffs || []),
        ...regex.parties.plaintiffs,
      ]),
      defendants: this.uniqueNames([
        ...(claude.parties?.defendants || []),
        ...regex.parties.defendants,
      ]),
      others: this.uniqueNames([
        ...(claude.parties?.others || []),
        ...regex.parties.others,
      ]),
    };

    const lawyers = this.uniqueNames([
      ...(claude.lawyers || []),
      ...regex.lawyers,
    ]);

    return {
      fileReference,
      judges,
      parties,
      lawyers,
      source: 'hybrid',
    };
  }

  private extractWithRegex(text: string): Omit<JudgmentMetadata, 'source'> {
    const fileReference = this.extractFileReference(text);
    const parties = this.extractParties(text);
    const judges = this.extractJudges(text);
    const lawyers = this.extractLawyers(text);

    return { fileReference, parties, judges, lawyers };
  }

  private extractFileReference(text: string): JudgmentFileReference {
    const parsed = parseReferenceFromText(text);
    const ref: JudgmentFileReference = {
      fileReferenceRaw: null,
      fileNumber: parsed?.fileNumber ?? null,
      fileCode: parsed?.fileCode ?? null,
      fileYear: parsed?.fileYear ?? null,
      decisionNumber: null,
      decisionDate: null,
      courtName: parsed?.courtName ?? null,
      courtSection: parsed?.courtSection ?? null,
      courtPanel: parsed?.courtPanel ?? null,
      courtType: parsed?.courtType ?? null,
      appealedFileReference: null,
    };

    const fileRaw =
      text.match(/رقم\s+الملف\s*[:：]\s*([\d/]+)/)?.[1] ||
      text.match(/ملف\s+عدد\s*[:：]?\s*([\d/]+)/)?.[1];
    if (fileRaw) {
      ref.fileReferenceRaw = fileRaw.trim();
      if (fileRaw.includes('/')) {
        ref.fileNumber = null;
        ref.fileCode = null;
        ref.fileYear = fileRaw.split('/')[0] || ref.fileYear;
      }
    }

    const decisionNum = text.match(/رقم\s+ال(?:قرار|حكم)\s*[:：]\s*([\d/]+)/)?.[1];
    if (decisionNum) ref.decisionNumber = decisionNum.trim();

    const decisionDate =
      text.match(/بتاريخ\s*[:：]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})/)?.[1] ||
      text.match(/في\s+(\d{4}[/-]\d{1,2}[/-]\d{1,2})/)?.[1];
    if (decisionDate) ref.decisionDate = decisionDate.replace(/\//g, '-');

    const appealed = text.match(/في\s+الملف\s+([\d/]+)/)?.[1];
    if (appealed) ref.appealedFileReference = appealed.trim();

    if (!ref.courtName) {
      const cassation = text.match(/(محكمة\s+النقض)/);
      if (cassation) {
        ref.courtName = cassation[1];
        ref.courtType = 'cassation';
      }
    }

    const chamber = text.match(
      /(الغرفة\s+[^\n،,.]+?)(?:\s+الهيئة|\s+بمحكمة|\s+في\s+جلستها)/,
    );
    if (chamber) {
      ref.courtSection = chamber[1].trim();
    }

    const panel = text.match(/(الهيئة\s+[^\n،,.]+?)(?:\s+بمحكمة|\s+في\s+جلستها)/);
    if (panel) {
      ref.courtPanel = panel[1].trim();
    }

    return ref;
  }

  private extractParties(text: string): JudgmentParties {
    const plaintiffs: string[] = [];
    const defendants: string[] = [];
    const others: string[] = [];

    const plaintiffBlock = this.sliceBetween(
      text,
      /(?:^|\n)\s*ب[\u064B-\u0652\u0670\u064E\u0650\u0651\u0652]*?ين\s*[:：]/,
      /(?:^|\n)\s*(?:الطالبة|الطالب|المستأنف(?:ة)?|المدع(?:ي|ية)|الطالبان)\s*(?:\n|$)/,
    );
    if (plaintiffBlock) {
      plaintiffs.push(...this.parseNumberedParties(plaintiffBlock));
    }

    const defendantBlock = this.sliceBetween(
      text,
      /(?:^|\n)\s*و\s*ب[\u064B-\u0652\u0670\u064E\u0650\u0651\u0652]*?ين\s*[:：]/,
      /(?:^|\n)\s*(?:المطلوب(?:ة)?|فيها|المستأنف\s+عليه|المستأنف\s+علي(?:ه|ها)|المدعى\s+علي(?:ه|ها))\s*(?:\n|$)/,
    );
    if (defendantBlock) {
      defendants.push(...this.parseNumberedParties(defendantBlock));
    }

    return {
      plaintiffs: this.uniqueNames(plaintiffs),
      defendants: this.uniqueNames(defendants),
      others: this.uniqueNames(others),
    };
  }

  private parseNumberedParties(block: string): string[] {
    const names: string[] = [];
    const lines = block.split('\n');
    let current = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const betweenInline = trimmed.match(
        /^ب[\u064B-\u0652\u0670\u064E\u0650\u0651\u0652]*?ين\s*[:：]\s*\d+\s*[-–—]\s*(.+)/,
      );
      const numbered = trimmed.match(/^\d+\s*[-–—]\s*(.+)/);
      const item = betweenInline?.[1] || numbered?.[1];

      if (item) {
        if (current) names.push(this.cleanPartyName(current));
        current = item;
        continue;
      }

      if (/^(?:ينوب|بواسطة|المحامي|النائب)/.test(trimmed)) {
        if (current) names.push(this.cleanPartyName(current));
        current = '';
        continue;
      }

      if (current) current += ' ' + trimmed;
    }

    if (current) names.push(this.cleanPartyName(current));
    return names.filter((n) => n.length > 2);
  }

  private cleanPartyName(raw: string): string {
    return raw
      .replace(/،\s*في\s+شخص\s+.+$/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractJudges(text: string): string[] {
    const judges: string[] = [];
    const patterns = [
      /المستشار(?:\s+المفرز)?\s+السيد(?:ة)?\s+([^،,\n]+?)(?:\s+و(?:ال)?|$)/g,
      /(?:رئيس|مستشار|عضو(?:\s+مقرر)?)\s+(?:المحكمة\s+)?السيد(?:ة)?\s+([^،,\n]+?)(?:\s+(?:رئيس|مستشار|عضو)|$)/g,
      /(?:قاض(?:ي|ية)|القاض(?:ي|ية))\s+السيد(?:ة)?\s+([^،,\n]+)/g,
    ];

    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = this.cleanPersonName(m[1]);
        if (name && name.length > 3 && !/مجلس|محكمة|الغرفة/.test(name)) {
          judges.push(name);
        }
      }
    }

    return this.uniqueNames(judges);
  }

  private extractLawyers(text: string): string[] {
    const lawyers: string[] = [];
    const patterns = [
      /(?:ينوب\s+عنه(?:ما|م)?|بواسطة\s+نائب(?:ه(?:ما|م)?)?)\s+(?:الأستاذ(?:ة)?\s+)?([^،,\n]+?)(?:،|\s+المحامي|\s+وال)/g,
      /المحامي(?:ة)?\s+(?:السيد(?:ة)?\s+)?(?:الأستاذ(?:ة)?\s+)?([^،,\n]+?)(?:،|\s+بهيئة|\s+و)/g,
    ];

    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = this.cleanPersonName(m[1]);
        if (
          name &&
          name.length > 3 &&
          !/^(?:بهيئة|هيئة|الدار)/.test(name)
        ) {
          lawyers.push(name);
        }
      }
    }

    return this.uniqueNames(lawyers);
  }

  private cleanPersonName(raw: string): string {
    return raw
      .replace(/^(?:ال)?(?:أ)?(?:ستاذ(?:ة)?)\s+/u, '')
      .replace(/\s+و(?:ال)?(?:استماع|الاستماع).+$/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private sliceBetween(
    text: string,
    startRe: RegExp,
    endRe: RegExp,
  ): string | null {
    const start = text.search(startRe);
    if (start < 0) return null;
    const afterStart = text.slice(start).replace(startRe, '');
    const end = afterStart.search(endRe);
    if (end < 0) return afterStart.slice(0, 2500);
    return afterStart.slice(0, end);
  }

  private uniqueNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
      const n = name.replace(/\s+/g, ' ').trim();
      if (!n || n.length < 2) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }
}
