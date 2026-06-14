/** App mount path (no trailing slash), e.g. `/lexia`. */
export const APP_BASE = (import.meta.env.VITE_BASE || '/lexia/').replace(/\/$/, '') || ''

export const appPath = (path: string) => `${APP_BASE}${path.startsWith('/') ? path : `/${path}`}`
