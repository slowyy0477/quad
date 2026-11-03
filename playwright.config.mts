import { defineConfig } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { assertCompiledPreparation } from './scripts/bulla/browser-acceptance.mjs'

// Explicit ESM keeps Playwright from transforming the preparation helper into
// CommonJS, where its import.meta and guarded top-level await cannot execute.
const baseURL = process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301'
const origin = new URL(baseURL)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Local Bulla smoke tests must not run against a remote or production service.')
}
const reuse = process.env.BULLA_E2E_USE_RUNNING_SERVER === '1'
if (reuse && process.env.BULLA_E2E_ISOLATED_DATA !== '1') {
  throw new Error('Reusing a local server requires explicit confirmation that it uses isolated test data.')
}
const taskRoot = process.env.BULLA_E2E_ARTIFACT_DIR ||
  (process.platform === 'win32' ? 'D:/All tasks + Automations/Bulla-Recovery/e2e' : path.join(os.tmpdir(), 'bulla-e2e'))
if (!path.isAbsolute(taskRoot)) throw new Error('The browser artifact directory must be absolute.')
const runId = process.env.BULLA_E2E_RUN_ID || randomUUID()
if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid browser test run identifier.')
process.env.BULLA_E2E_RUN_ID = runId
const runRoot = path.join(taskRoot, runId)
const serverMode = process.env.BULLA_E2E_SERVER_MODE || 'development'
if (!['development', 'production'].includes(serverMode)) throw new Error('Invalid isolated browser server mode.')
if (serverMode === 'production' && (
  reuse || process.env.BULLA_E2E_USE_RUNNING_SERVER !== '0' ||
  origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || origin.port === '3000' ||
  process.env.NEXT_PUBLIC_DATA_MODE !== 'local' ||
  process.env.NEXT_PUBLIC_SUPABASE_URL !== '' || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' ||
  process.env.SUPABASE_SERVICE_ROLE_KEY !== '' ||
  process.env.LOCAL_DATA_PATH !== path.join(runRoot, 'fixture', 'local.json') ||
  process.env.BULLA_LOCAL_MEDIA_ROOT !== path.join(runRoot, 'fixture', 'media')
)) {
  throw new Error('Compiled browser testing requires the fresh local-only runner and its isolated fixture.')
}
if (serverMode === 'production') assertCompiledPreparation(process.env)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  outputDir: path.join(runRoot, 'results'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(runRoot, 'results.json') }],
    ['html', { outputFolder: path.join(runRoot, 'report'), open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    ...(process.env.BULLA_E2E_BROWSER ? { channel: process.env.BULLA_E2E_BROWSER } : {}),
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: reuse ? undefined : {
    command: `npm run ${serverMode === 'production' ? 'start' : 'dev'} -- --hostname 127.0.0.1 --port ${origin.port || '3301'}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_DATA_MODE: 'local',
      NEXT_PUBLIC_SUPABASE_URL: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      NEXT_PUBLIC_SITE_URL: origin.origin,
      NODE_ENV: serverMode,
      LOCAL_DATA_PATH: path.join(runRoot, 'fixture', 'local.json'),
      BULLA_LOCAL_MEDIA_ROOT: path.join(runRoot, 'fixture', 'media'),
      BULLA_REQUIRE_HTTPS: '0',
      QUAD_REQUIRE_HTTPS: '0',
      BULLA_ALLOW_LOCAL_IN_PRODUCTION: serverMode === 'production' ? '1' : '0',
      QUAD_ALLOW_LOCAL_IN_PRODUCTION: '0',
      BULLA_NEXT_DIST_DIR: process.env.BULLA_E2E_DIST_DIR || '.next-bulla-e2e',
    },
  },
})
