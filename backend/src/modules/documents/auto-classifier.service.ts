import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

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

  async classify(
    text: string,
    openaiClient: OpenAI,
  ): Promise<ClassificationResult> {
    const sample = text.slice(0, 2000);

    try {
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a Moroccan legal document classifier. Analyze the document and respond with JSON:
{
  "collection": "one of: legal_laws|judgments_commercial|judgments_civil|judgments_admin|judgments_criminal|judgments_family|judgments_social|judgments_real_estate|judgments_constitutional|user_documents",
  "courtName": "court name if judgment",
  "city": "city if available",
  "date": "document date if found",
  "caseNumber": "case number if judgment",
  "confidence": 0.0-1.0
}`,
          },
          {
            role: 'user',
            content: `Classify this Moroccan legal document:\n\n${sample}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300,
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const collection = VALID_COLLECTIONS.includes(parsed.collection)
        ? parsed.collection
        : this.fallbackClassify(text);

      const confidence = parsed.confidence ?? 0.5;

      const result: ClassificationResult = {
        collection: confidence >= 0.7 ? collection : this.fallbackClassify(text),
        jurisdiction: {
          courtName: parsed.courtName,
          city: parsed.city,
          date: parsed.date,
          caseNumber: parsed.caseNumber,
        },
        confidence,
      };

      return result;
    } catch (err) {
      this.logger.error(`Classification failed: ${err.message}`);
      return {
        collection: this.fallbackClassify(text),
        jurisdiction: {},
        confidence: 0.3,
      };
    }
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
