import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// receiver 部署到 GitHub Pages 项目页（/wink/ 子路径）——必须用相对 base
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  server: {
    host: true, // 局域网可访问
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
