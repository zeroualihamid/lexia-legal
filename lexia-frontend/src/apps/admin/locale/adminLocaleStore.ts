import { create } from 'zustand'

export type AdminLocale = 'fr' | 'ar'

const STORAGE_KEY = 'lexia.admin.locale'

function readInitial(): AdminLocale {
  if (typeof window === 'undefined') return 'fr'
  const saved = window.localStorage.getItem(STORAGE_KEY)
  return saved === 'ar' ? 'ar' : 'fr'
}

interface AdminLocaleState {
  locale: AdminLocale
  setLocale: (locale: AdminLocale) => void
  toggleLocale: () => void
}

export const useAdminLocaleStore = create<AdminLocaleState>((set, get) => ({
  locale: readInitial(),
  setLocale: (locale) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, locale)
    }
    set({ locale })
  },
  toggleLocale: () => {
    const next: AdminLocale = get().locale === 'fr' ? 'ar' : 'fr'
    get().setLocale(next)
  },
}))
