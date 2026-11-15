import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy API + WebSocket to the Node server (override with DDZ_SERVER=http://host:port).
const target = process.env.DDZ_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
