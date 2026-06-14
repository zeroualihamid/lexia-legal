export const COLLECTION_COLORS: Record<string, string> = {
  legal_laws: '#1677ff',
  judgments_commercial: '#fa8c16',
  judgments_civil: '#52c41a',
  judgments_admin: '#722ed1',
  judgments_criminal: '#f5222d',
  judgments_family: '#eb2f96',
  judgments_social: '#13c2c2',
  judgments_real_estate: '#a0d911',
  judgments_constitutional: '#faad14',
  user_documents: '#8c8c8c',
}

export const COLLECTION_LABELS: Record<string, string> = {
  legal_laws: 'القوانين التشريعية',
  judgments_commercial: 'الأحكام التجارية',
  judgments_civil: 'الأحكام المدنية',
  judgments_admin: 'الأحكام الإدارية',
  judgments_criminal: 'الأحكام الجنائية',
  judgments_family: 'أحكام الأسرة',
  judgments_social: 'الأحكام الاجتماعية',
  judgments_real_estate: 'الأحكام العقارية',
  judgments_constitutional: 'الأحكام الدستورية',
  user_documents: 'وثائقي',
}

// Legal document taxonomy — keep ids in sync with the backend
// (lexia-backend/src/modules/documents/document-types.ts).
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  contract: 'عقد / اتفاقية',
  pleading: 'مذكرة / مقال',
  judgment: 'حكم / قرار قضائي',
  minutes: 'محضر',
  correspondence: 'مراسلة',
  power_of_attorney: 'وكالة / توكيل',
  legal_memo: 'استشارة / مذكرة بحث',
  official_doc: 'وثيقة إدارية / رسمية',
  financial: 'فاتورة / وثيقة مالية',
  expert_report: 'تقرير خبير',
  other: 'أخرى',
}

export const DOCUMENT_TYPE_COLORS: Record<string, string> = {
  contract: '#1677ff',
  pleading: '#722ed1',
  judgment: '#fa8c16',
  minutes: '#13c2c2',
  correspondence: '#eb2f96',
  power_of_attorney: '#a0d911',
  legal_memo: '#52c41a',
  official_doc: '#faad14',
  financial: '#f5222d',
  expert_report: '#2f54eb',
  other: '#8c8c8c',
}

export const DOCUMENT_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  processing: { label: 'قيد المعالجة', color: '#1677ff' },
  ready: { label: 'جاهز', color: '#52c41a' },
  failed: { label: 'فشل', color: '#f5222d' },
  pending_review: { label: 'بانتظار المراجعة', color: '#faad14' },
  published: { label: 'منشور', color: '#52c41a' },
}

export const CASE_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: 'مفتوحة', color: '#52c41a' },
  closed: { label: 'مغلقة', color: '#8c8c8c' },
  archived: { label: 'مؤرشفة', color: '#faad14' },
}

// State of the background mahakim.ma case-tracking lookup.
export const MAHAKIM_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  idle: { label: 'غير مرتبط', color: '#8c8c8c' },
  queued: { label: 'في قائمة الانتظار', color: '#1677ff' },
  processing: { label: 'جارٍ الجلب من محاكم', color: '#1677ff' },
  ready: { label: 'تم الجلب', color: '#52c41a' },
  not_found: { label: 'لا توجد نتائج', color: '#faad14' },
  failed: { label: 'فشل الجلب', color: '#f5222d' },
  unsupported: { label: 'غير مدعوم على البوابة', color: '#faad14' },
}

// Court tiers. mahakim.ma's public tracking only covers first-instance and
// appeal courts; Cassation (محكمة النقض) is captured but not auto-fetched.
export const COURT_TYPE_LABELS: Record<string, string> = {
  first_instance: 'المحكمة الابتدائية',
  appeal: 'محكمة الاستئناف',
  cassation: 'محكمة النقض',
}

export const SUPREME_COURT_NAME = 'محكمة النقض'

// Courts of appeal in Morocco — exact mahakim.ma dropdown labels.
export const APPEAL_COURTS: string[] = [
  'محكمة الاستئناف بالرباط',
  'محكمة الاستئناف بالدار البيضاء',
  'محكمة الاستئناف بأكادير',
  'محكمة الاستئناف بورزازات',
  'محكمة الاستئناف ببني ملال',
  'محكمة الاستئناف بمراكش',
  'محكمة الاستئناف بكلميم',
  'محكمة الاستئناف بالحسيمة',
  'محكمة الاستئناف بتازة',
  'محكمة الاستئناف بمكناس',
  'محكمة الاستئناف بالرشيدية',
  'محكمة الاستئناف بالناضور',
  'محكمة الاستئناف بآسفي',
  'محكمة الاستئناف بخريبكة',
  'محكمة الاستئناف بتطوان',
  'محكمة الاستئناف بفاس',
  'محكمة الاستئناف بطنجة',
  'محكمة الاستئناف بالقنيطرة',
  'محكمة الاستئناف بالعيون',
  'محكمة الاستئناف بالجديدة',
  'محكمة الاستئناف بسطات',
  'محكمة الاستئناف بوجدة',
]

// Brand accent — fixed across themes.
export const GOLD = '#c9a84c'

// Theme-aware tokens. These resolve to the CSS variables defined in
// `index.css`, which switch on the [data-theme] attribute of <html>.
// Existing imports of `DARK`/`NAVY`/`DARK_CARD`/`BORDER_COLOR` now flip
// automatically with the active theme.
export const DARK = 'var(--color-bg-base)'
export const NAVY = 'var(--color-bg-sidebar)'
export const DARK_CARD = 'var(--color-bg-card)'
export const ELEVATED = 'var(--color-bg-elevated)'
export const BG_DEEP = 'var(--color-bg-deep)'
export const BORDER_COLOR = 'var(--color-border)'
export const BORDER_SUBTLE = 'var(--color-border-subtle)'

export const TEXT_PRIMARY = 'var(--color-text-primary)'
export const TEXT_SECONDARY = 'var(--color-text-secondary)'
export const TEXT_TERTIARY = 'var(--color-text-tertiary)'
export const TEXT_QUATERNARY = 'var(--color-text-quaternary)'

export const GOLD_TINT = 'var(--color-gold-tint)'
export const GOLD_TINT_STRONG = 'var(--color-gold-tint-strong)'
export const GOLD_BORDER = 'var(--color-gold-border)'
