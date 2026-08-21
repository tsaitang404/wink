import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: 'bench-zxing-dist',
    target: 'es2020',
    rollupOptions: {
      input: resolve(fileURLToPath(new URL('.', import.meta.url)), 'bench-zxing.html'),
    },
  },
});
