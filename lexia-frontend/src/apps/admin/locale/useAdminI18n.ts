import type { CSSProperties } from 'react'
import { adminFr, type AdminMessages } from './admin.fr'
import { adminAr } from './admin.ar'
import { useAdminLocaleStore, type AdminLocale } from './adminLocaleStore'

export type AdminDirection = 'ltr' | 'rtl'

export const ADMIN_FONTS = {
  fr: "'Segoe UI', system-ui, -apple-system, sans-serif",
  ar: "'Noto Naskh Arabic', 'Cairo', sans-serif",
} as const

export const adminMessages: Record<AdminLocale, AdminMessages> = {
  fr: adminFr,
  ar: adminAr,
}

export function useAdminI18n() {
  const locale = useAdminLocaleStore((s) => s.locale)
  const setLocale = useAdminLocaleStore((s) => s.setLocale)
  const toggleLocale = useAdminLocaleStore((s) => s.toggleLocale)

  const isRtl = locale === 'ar'
  const dir: AdminDirection = isRtl ? 'rtl' : 'ltr'
  const font = ADMIN_FONTS[locale]
  const numberLocale = locale === 'fr' ? 'fr-FR' : 'ar-MA'
  const t = adminMessages[locale]

  return { locale, setLocale, toggleLocale, isRtl, dir, font, numberLocale, t }
}

export function useAdminUi() {
  const { locale, setLocale, toggleLocale, isRtl, dir, font, numberLocale, t } = useAdminI18n()

  const textAlign: CSSProperties['textAlign'] = isRtl ? 'right' : 'left'
  const pageStyle: CSSProperties = { direction: dir, textAlign }
  const formStyle: CSSProperties = { direction: dir, marginTop: 16 }
  const tableStyle: CSSProperties = { direction: dir }
  const h1Style: CSSProperties = {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    fontFamily: font,
    margin: 0,
  }
  const labelStyle: CSSProperties = { fontFamily: font, color: 'var(--color-text-secondary)' }
  const titleStyle: CSSProperties = { fontFamily: font, color: 'var(--color-text-primary)' }
  const cellStyle: CSSProperties = { fontFamily: font, color: 'var(--color-text-primary)', fontSize: 13 }
  const mutedStyle: CSSProperties = { fontFamily: font, color: 'var(--color-text-tertiary)', fontSize: 12 }

  const collectionOptions = Object.entries(t.collections).map(([value, label]) => ({ value, label }))
  const collectionLabel = (key: string) => t.collections[key as keyof typeof t.collections] || key
  const roleOptions = (includeAll = false) => {
    const opts = Object.entries(t.roles).map(([value, label]) => ({ value, label }))
    return includeAll ? [{ value: '', label: t.common.allRoles }, ...opts] : opts
  }

  return {
    locale,
    setLocale,
    toggleLocale,
    isRtl,
    dir,
    font,
    numberLocale,
    textAlign,
    t,
    pageStyle,
    formStyle,
    tableStyle,
    h1Style,
    labelStyle,
    titleStyle,
    cellStyle,
    mutedStyle,
    collectionOptions,
    collectionLabel,
    roleOptions,
  }
}
