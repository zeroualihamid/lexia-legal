import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const base = process.env.VITE_BASE || '/lexia/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 3000,
    proxy: { '/api': 'http://localhost:4101' },
  },
})
