import React, { useEffect } from 'react'
import { ConfigProvider } from 'antd'
import frFR from 'antd/locale/fr_FR'
import arEG from 'antd/locale/ar_EG'
import { useAdminI18n, ADMIN_FONTS, type AdminDirection } from './useAdminI18n'

export function AdminLocaleProvider({ children }: { children: React.ReactNode }) {
  const { locale, dir, isRtl } = useAdminI18n()
  const antLocale = locale === 'fr' ? frFR : arEG
  const panelClass = isRtl ? 'admin-panel-rtl' : 'admin-panel-ltr'
  const direction: AdminDirection = dir

  useEffect(() => {
    const html = document.documentElement
    const prevDir = html.getAttribute('dir')
    const prevLang = html.getAttribute('lang')
    html.setAttribute('dir', dir)
    html.setAttribute('lang', locale)
    return () => {
      if (prevDir) html.setAttribute('dir', prevDir)
      else html.setAttribute('dir', 'rtl')
      if (prevLang) html.setAttribute('lang', prevLang)
      else html.removeAttribute('lang')
    }
  }, [dir, locale])

  return (
    <ConfigProvider
      direction={direction}
      locale={antLocale}
      theme={{ token: { fontFamily: ADMIN_FONTS[locale] } }}
    >
      <div className={panelClass} lang={locale} dir={dir}>
        {children}
      </div>
    </ConfigProvider>
  )
}
