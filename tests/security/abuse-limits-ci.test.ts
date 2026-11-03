import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Already installed/locked by ESLint; no package or lockfile mutation required.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => unknown }
type Step = { name?: string; run?: string; uses?: string; with?: { path?: string }; if?: string }
type Job = {
  env?: Record<string, string>
  steps: Step[]
  services?: Record<string, { image: string; env: Record<string, string>; ports: string[] }>
}
const source = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const workflow = load(source) as { permissions: Record<string, string>; env: Record<string, string>; jobs: Record<string, Job> }
const verifier = await readFile(new URL('../../scripts/bulla/verify.mjs', import.meta.url), 'utf8')
const checker = await readFile(new URL('../../scripts/bulla/check-build.mjs', import.meta.url), 'utf8')
const browser = await readFile(new URL('../../playwright.config.mts', import.meta.url), 'utf8')

describe('R21 CI parity and report privacy', () => {
  it('checks the complete current TypeScript source instead of relying on an earlier incremental cache', () => {
    expect(verifier).toContain(
      "['Non-incremental TypeScript', cli('typescript/bin/tsc'), ['--noEmit', '--incremental', 'false']]",
    )
  })

  it('keeps read-only repo permissions and never injects owner/hosted credentials', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env.NEXT_PUBLIC_DATA_MODE).toBe('local')
    for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect(workflow.env[key]).toBe('')
    }
    expect(source).not.toMatch(/\$\{\{\s*secrets\./)
    expect(source).not.toMatch(/D:[\\/]+Quad|site-data[\\/]+local\.json/i)
  })

  it('reuses the actual nonempty canary/checker path instead of an empty-key-skippable scan', () => {
    expect(workflow.jobs.build.steps.some(step => step.run === 'npm run verify:bulla -- --build')).toBe(true)
    expect(verifier).toContain('const buildCanary = `bulla-server-only-canary-${randomUUID()}`')
    expect(verifier).toContain('SUPABASE_SERVICE_ROLE_KEY: buildCanary')
    expect(verifier).toContain('BULLA_BUILD_SECRET_CANARY: buildCanary')
    expect(verifier).toContain('scripts/bulla/check-build.mjs')
    expect(checker).toContain("if (!canary || canary.length < 24) throw")
    expect(checker).toContain('manifests.length > 0 && clientFiles.length > 0')
    expect(source).not.toContain('if [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]')
  })

  it('runs real browser tests on a loopback, new store with no reused owner server', () => {
    const job = workflow.jobs.e2e
    expect(workflow.env.BULLA_E2E_USE_RUNNING_SERVER).toBe('0')
    expect(job.env?.BULLA_E2E_BASE_URL).toBe('http://127.0.0.1:3301')
    expect(job.env?.BULLA_E2E_ARTIFACT_DIR).toContain('${{ runner.temp }}')
    expect(job.steps.some(step => step.run === 'npm run test:e2e')).toBe(true)
    expect(job.steps.some(step => step.run?.includes('playwright install --with-deps chromium'))).toBe(true)
    expect(browser).toContain('reuseExistingServer: false')
    expect(browser).toContain("LOCAL_DATA_PATH: path.join(runRoot, 'fixture', 'local.json')")
    expect(browser).toContain('must not run against a remote or production service')
  })

  it('uploads only evidence JSON/Markdown/screenshots, never stores, traces, HTML bundles or secrets', () => {
    const uploads = Object.values(workflow.jobs).flatMap(job =>
      job.steps.filter(step => step.uses === 'actions/upload-artifact@v4'),
    )
    expect(uploads).toHaveLength(4)
    for (const step of uploads) {
      expect(step.if).toBe('always()')
      const paths = step.with?.path?.trim().split('\n') ?? []
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) {
        expect(path).toMatch(/(?:\.md|\.json|\*\.png)$/)
        expect(path).not.toMatch(/fixture|local\.json|\.env|trace|report\/|\.next|node_modules|\.zip/)
      }
    }
  })

  it('provisions native independent connections only in an explicit job-local empty test database', () => {
    const job = workflow.jobs['abuse-concurrency']
    expect(job.services?.postgres.image).toBe('postgres:18')
    expect(job.services?.postgres.env.POSTGRES_DB).toBe('bulla_abuse_test')
    expect(job.env?.BULLA_ABUSE_TEST_ISOLATED).toBe('1')
    expect(job.env?.BULLA_ABUSE_TEST_DATABASE_URL).toMatch(/@127\.0\.0\.1:.*\/bulla_abuse_test$/)
    expect(job.steps.some(step => step.run?.includes('tests/security/abuse-limits-concurrency.test.ts'))).toBe(true)
    expect(job.env?.BULLA_TEST_TMP_DIR).toContain('${{ runner.temp }}')
  })
})
