import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.TTC_DEPLOY_BASE || '/',
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
