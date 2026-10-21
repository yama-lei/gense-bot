import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import agents from 'agents/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [agents(), react(), cloudflare()],
})
