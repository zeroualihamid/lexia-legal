import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const base = process.env.VITE_BASE || '/lexia/'

// Target for the dev /api proxy. Default: nginx on :80 (same path as production).
// Avoid localhost:6010 — it often conflicts with Cursor port forwarding on macOS.
// Override with VITE_PROXY_TARGET (e.g. http://localhost:6010) if needed.
const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://localhost'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
        secure: false,
      },
      '/legal-graphs': {
        target: proxyTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
