import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@lib': path.resolve(import.meta.dirname, '..', 'lib') } },
  server: { port: 5848, proxy: { '/api': `http://localhost:${process.env.BATESON_PORT || 4848}` } },
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
});
