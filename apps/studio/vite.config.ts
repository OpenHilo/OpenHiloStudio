import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'client/src') },
  },
});
