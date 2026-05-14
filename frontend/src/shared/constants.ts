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
