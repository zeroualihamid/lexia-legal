import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const base = process.env.VITE_BASE || '/lexia/'

// Target for the dev /api proxy. Defaults to the docker-compose backend
// published on host port 6010; override with VITE_PROXY_TARGET if needed.
const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:6010'

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
    },
  },
})
