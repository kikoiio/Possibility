// web/vite.config.ts — 信息流前端构建（产物为纯静态文件）
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
