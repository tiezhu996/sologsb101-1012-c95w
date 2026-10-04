import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// 单元测试配置：仅跑 src 下的 *.test.ts，IndexedDB 由 fake-indexeddb 提供
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
