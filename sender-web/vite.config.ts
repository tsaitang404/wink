import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// sender-web 构建成单 HTML（file:// 双击即用，零依赖）
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 100000000,
  },
});
