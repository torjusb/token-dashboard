import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  build: { outDir: '../web/dist', emptyOutDir: true },
});
