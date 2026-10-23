import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Node host (npm start -w @gense/host-node) serves /api and /ws; Vite proxies them in dev.
const host = process.env.GENSE_HOST ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': host,
      '/ws': { target: host, ws: true },
    },
  },
})
