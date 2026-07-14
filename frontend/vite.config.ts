import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // `ws: true` is required — the board's live socket (/api/interviews/live) is an HTTP upgrade,
      // and Vite's proxy does NOT forward upgrades unless asked. Without it the socket never
      // connects in dev and the board silently falls back to being non-collaborative.
      '/api': { target: 'http://127.0.0.1:8503', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
