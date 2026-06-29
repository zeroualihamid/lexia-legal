import { Injectable, Logger } from '@nestjs/common';
import { ClaudeCodeService } from '../../common/claude/claude-code.service';

interface ClassificationResult {
  collection: string;
  jurisdiction: {
    courtName?: string;
    city?: string;
    date?: string;
    caseNumber?: string;
  };
  confidence: number;
}

const VALID_COLLECTIONS = [
  'legal_laws',
  'judgments_commercial',
  'judgments_civil',
  'judgments_admin',
  'judgments_criminal',
  'judgments_family',
  'judgments_social',
  'judgments_real_estate',
  'judgments_constitutional',
  'user_documents',
];

@Injectable()
export class AutoClassifierService {
  private readonly logger = new Logger(AutoClassifierService.name);

  constructor(private readonly claudeCode: ClaudeCodeService) {}

  async classify(text: string): Promise<ClassificationResult> {
    const sample = text.slice(0, 2000);

    if (!this.claudeCode.isAvailable()) {
      this.logger.warn('Claude Code unavailable — keyword fallback for classify');
      return {
        collection: this.fallbackClassify(text),
        jurisdiction: {},
        confidence: 0.3,
      };
    }

    try {
      const parsed = await this.claudeCode.invokeJson<{
        collection?: string;
        courtName?: string;
        city?: string;
        date?: string;
        caseNumber?: string;
        confidence?: number;
      }>(
        `You are a Moroccan legal document classifier. Analyze the document and respond with JSON only (no markdown):
{
  "collection": "one of: legal_laws|judgments_commercial|judgments_civil|judgments_admin|judgments_criminal|judgments_family|judgments_social|judgments_real_estate|judgments_constitutional|user_documents",
  "courtName": "court name if judgment",
  "city": "city if available",
  "date": "document date if found",
  "caseNumber": "case number if judgment",
  "confidence": 0.0
}

Classify this Moroccan legal document:

${sample}`,
        { label: 'document-classify' },
      );

      if (!parsed) {
        throw new Error('Claude returned no JSON');
      }

      const collection = VALID_COLLECTIONS.includes(parsed.collection)
        ? parsed.collection
        : this.fallbackClassify(text);

      const confidence = parsed.confidence ?? 0.5;

      return {
        collection: confidence >= 0.7 ? collection : this.fallbackClassify(text),
        jurisdiction: {
          courtName: parsed.courtName,
          city: parsed.city,
          date: parsed.date,
          caseNumber: parsed.caseNumber,
        },
        confidence,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Classification failed: ${message}`);
      return {
        collection: this.fallbackClassify(text),
        jurisdiction: {},
        confidence: 0.3,
      };
    }
  }

  /**
   * Judgment-focused classification for files dropped in the main chat. Unlike
   * `classify` (which can pick the `user_documents` catch-all), this decides
   * whether the document is a court decision and, if so, the right
   * `judgments_*` sub-collection. A strong Arabic keyword heuristic guards
   * against the LLM under-classifying obvious judgments.
   */
  async classifyJudgment(
    text: string,
  ): Promise<{ isJudgment: boolean; collection: string }> {
    const looksJudgment = this.looksLikeJudgment(text);
    const sample = text.slice(0, 3000);

    if (!this.claudeCode.isAvailable()) {
      if (looksJudgment) {
        return {
          isJudgment: true,
          collection: this.judgmentSubcollection(text),
        };
      }
      return { isJudgment: false, collection: 'user_documents' };
    }

    try {
      const parsed = await this.claudeCode.invokeJson<{
        isJudgment?: boolean;
        category?: string;
      }>(
        `You analyse Moroccan legal documents. Decide if the document is a COURT JUDGMENT or DECISION (حكم / قرار قضائي صادر عن محكمة), as opposed to a contract, pleading, expertise, correspondence, etc.
Respond with JSON only (no markdown):
{
  "isJudgment": true,
  "category": "commercial|civil|admin|criminal|family|social|real_estate|constitutional"
}
"category" is the judgment's domain (only meaningful when isJudgment is true).

Document:

${sample}`,
        { label: 'judgment-classify' },
      );

      if (!parsed) {
        throw new Error('Claude returned no JSON');
      }

      const isJudgment = parsed.isJudgment === true || looksJudgment;
      if (!isJudgment) {
        return { isJudgment: false, collection: 'user_documents' };
      }
      const collection = this.judgmentCollectionFor(parsed.category, text);
      return { isJudgment: true, collection };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Judgment classification failed: ${message}`);
      if (looksJudgment) {
        return {
          isJudgment: true,
          collection: this.judgmentSubcollection(text),
        };
      }
      return { isJudgment: false, collection: 'user_documents' };
    }
  }

  /** Strong markers that a Moroccan court decision is present. */
  private looksLikeJudgment(text: string): boolean {
    const t = text.slice(0, 6000);
    const markers = [
      'محكمة النقض',
      'محكمة الاستئناف',
      'المحكمة الابتدائية',
      'المحكمة التجارية',
      'المحكمة الإدارية',
      'باسم جلالة الملك',
      'أصدرت القرار',
      'أصدرت الحكم',
      'القرار الآتي',
      'الحكم الآتي',
      'القرار عدد',
      'حكم عدد',
      'قرار رقم',
      'الغرفة التجارية',
      'الغرفة المدنية',
      'الغرفة الجنائية',
      'الغرفة الإدارية',
    ];
    const hits = markers.filter((m) => t.includes(m)).length;
    return hits >= 2;
  }

  /** Map an LLM domain hint to a judgments_* collection (keyword fallback). */
  private judgmentCollectionFor(category: string | undefined, text: string): string {
    const map: Record<string, string> = {
      commercial: 'judgments_commercial',
      civil: 'judgments_civil',
      admin: 'judgments_admin',
      criminal: 'judgments_criminal',
      family: 'judgments_family',
      social: 'judgments_social',
      real_estate: 'judgments_real_estate',
      constitutional: 'judgments_constitutional',
    };
    if (category && map[category]) return map[category];
    return this.judgmentSubcollection(text);
  }

  /**
   * Keyword-based judgment sub-category. Unlike `fallbackClassify`, this never
   * returns `legal_laws`/`user_documents` — it always resolves to a
   * `judgments_*` collection (defaulting to civil).
   */
  private judgmentSubcollection(text: string): string {
    const t = text.slice(0, 8000);
    const has = (...kw: string[]) => kw.some((k) => t.includes(k));
    if (has('تجاري', 'تجارية', 'الأصل التجاري', 'الكراء التجاري', 'الشركة', 'شركة'))
      return 'judgments_commercial';
    if (has('المحكمة الإدارية', 'إداري', 'إدارية', 'الصفقات العمومية', 'نزع الملكية'))
      return 'judgments_admin';
    if (has('جنائي', 'جنحة', 'جنحي', 'المتهم', 'النيابة العامة', 'عقوبة', 'الجناية'))
      return 'judgments_criminal';
    if (has('مدونة الأسرة', 'الطلاق', 'النفقة', 'الحضانة', 'التطليق', 'الإرث'))
      return 'judgments_family';
    if (has('الشغل', 'الطرد التعسفي', 'الضمان الاجتماعي', 'مدونة الشغل', 'أجير'))
      return 'judgments_social';
    if (has('عقاري', 'التحفيظ العقاري', 'الرسم العقاري', 'المحافظة العقارية'))
      return 'judgments_real_estate';
    return 'judgments_civil';
  }

  private fallbackClassify(text: string): string {
    const lower = text.toLowerCase();

    if (
      text.includes('قانون') ||
      text.includes('ظهير') ||
      text.includes('مرسوم') ||
      text.includes('المادة')
    ) {
      return 'legal_laws';
    }
    if (text.includes('تجار') || lower.includes('commercial')) {
      return 'judgments_commercial';
    }
    if (text.includes('إداري') || lower.includes('administratif')) {
      return 'judgments_admin';
    }
    if (text.includes('جنائي') || text.includes('جنحة') || text.includes('جناية')) {
      return 'judgments_criminal';
    }
    if (text.includes('أسرة') || text.includes('طلاق') || text.includes('نفقة')) {
      return 'judgments_family';
    }
    if (text.includes('شغل') || text.includes('عمال') || text.includes('اجتماعي')) {
      return 'judgments_social';
    }
    if (text.includes('عقار') || text.includes('ملكية') || text.includes('كراء')) {
      return 'judgments_real_estate';
    }
    if (text.includes('دستور') || text.includes('المحكمة الدستورية')) {
      return 'judgments_constitutional';
    }

    return 'judgments_civil';
  }
}
