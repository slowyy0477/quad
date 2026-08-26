import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * Two test environments in one config, split by file location:
 *
 *   - `tests/db/**`, `tests/security/**`, `tests/integration/**` and
 *     `src/**\/*.node.test.ts` run in `node`. Database tests boot a real
 *     Postgres (PGlite) and cannot run in a DOM environment.
 *   - everything else runs in `jsdom` for component tests.
 *
 * Playwright owns `tests/e2e/**`; it is excluded here so `vitest run` does not
 * try to execute browser specs.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
    // A cold PGlite boot plus twenty migrations is a second or two; the default
    // 5s timeout makes that look like a hang.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: [
            'tests/db/**/*.test.ts',
            'tests/security/**/*.test.ts',
            'tests/integration/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        // Generated from the database; asserting on it would test Supabase's
        // codegen rather than our code.
        'src/lib/db/database.types.ts',
      ],
    },
  },
})
