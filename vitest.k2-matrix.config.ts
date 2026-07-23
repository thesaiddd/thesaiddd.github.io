import { defineConfig } from 'vitest/config';

process.env.TZ = 'Europe/Istanbul';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/k2-financial-matrix.runner.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    reporters: ['verbose'],
  },
});
