import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3412,
    proxy: {
      '/api': 'http://localhost:3411',
      '/stream': 'http://localhost:3411',
    },
  },
  build: {
    outDir: 'dist',
  },
})
