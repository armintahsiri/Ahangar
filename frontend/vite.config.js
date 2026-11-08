import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // expose the dev server on the LAN (0.0.0.0) so other devices can open it
    host: true,
    port: Number(process.env.FRONTEND_PORT || 5173),
    strictPort: true,
    proxy: {
      // changeOrigin: false for /api — the API checks the Origin host against Host, and
      // rewriting Host to the backend target would 403 dev access from LAN IPs
      '/api': { target: backend, changeOrigin: false },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})
