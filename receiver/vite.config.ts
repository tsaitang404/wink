import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// receiver 部署到静态服务器（手机摄像头需要 https/localhost 安全上下文）
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
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
