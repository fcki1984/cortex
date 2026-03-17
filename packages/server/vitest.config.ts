import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const vitestTmpDir = resolve(process.cwd(), 'node_modules', '.tmp', 'vitest');
mkdirSync(vitestTmpDir, { recursive: true });
process.env.TMPDIR = vitestTmpDir;
process.env.TMP = vitestTmpDir;
process.env.TEMP = vitestTmpDir;

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
