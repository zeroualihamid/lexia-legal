/**
 * Resolve a public/static asset path against Vite's BASE_URL.
 *
 * Assets in `public/` are copied to the build output root and referenced with
 * root-relative URLs (e.g. `/logo.png`). When the app is served under a
 * subpath (e.g. nginx `location /qclick/`), those root-relative URLs resolve
 * against the wrong path and 404. Vite injects `BASE_URL` at build time based
 * on the `base` option (or `VITE_BASE`), so prefixing it here keeps the same
 * source working for both dev (`/`) and deployed (`/qclick/`) environments.
 *
 * Vite rewrites `index.html` asset URLs automatically, but JSX literals like
 * `<img src="/logo.png">` are **not** rewritten — they must use this helper.
 */
export const asset = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
