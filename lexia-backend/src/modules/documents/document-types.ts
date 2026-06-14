/**
 * Legal document taxonomy (benchmark-aligned, Arabic-first).
 *
 * Stored as `documents.document_type` and mirrored into the Qdrant payload
 * (`doc_type`). The frontend keeps the Arabic labels; the backend only needs
 * the set of valid identifiers for validation. Keep in sync with
 * `lexia-frontend/src/shared/constants.ts` (DOCUMENT_TYPE_LABELS).
 */
export const DOCUMENT_TYPES = [
  'contract', // عقد / اتفاقية
  'pleading', // مذكرة / مقال
  'judgment', // حكم / قرار قضائي
  'minutes', // محضر
  'correspondence', // مراسلة
  'power_of_attorney', // وكالة / توكيل
  'legal_memo', // استشارة / مذكرة بحث
  'official_doc', // وثيقة إدارية / رسمية
  'financial', // فاتورة / وثيقة مالية
  'expert_report', // تقرير خبير
  'other', // أخرى
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DEFAULT_DOCUMENT_TYPE: DocumentType = 'other';

export function normalizeDocumentType(value?: string | null): DocumentType {
  if (value && (DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return value as DocumentType;
  }
  return DEFAULT_DOCUMENT_TYPE;
}
