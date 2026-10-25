import { defineConfig } from 'vite';

export default defineConfig({
  root: 'packages/web',
  build: { outDir: 'dist' },
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
});
