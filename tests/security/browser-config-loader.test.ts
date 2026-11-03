import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { childEnvironment, planRuns, playwrightArguments } from '../../scripts/bulla/browser-acceptance.mjs'

const execute = promisify(execFile)
const checkout = fileURLToPath(new URL('../../', import.meta.url))

it.each([
  'tests/e2e/header-graph.spec.ts',
  'tests/e2e/notification-read.spec.mts',
])('the actual Playwright loader can enumerate %s and the ESM config without starting a server or writing a fixture', async (spec) => {
  const taskRoot = process.platform === 'win32'
    ? 'D:/All tasks + Automations/Bulla-Recovery/test-fixtures'
    : path.join(os.tmpdir(), 'bulla-config-enumeration')
  const aggregate = path.join(taskRoot, `module-enumeration-${randomUUID()}`)
  const run = planRuns([spec], aggregate, 3349)[0]
  const exists = async (target: string) => {
    try { await access(target); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  expect(await exists(aggregate)).toBe(false)
  const env = {
    ...childEnvironment(process.env, run, '.next-bulla-e2e'),
    NODE_ENV: 'development' as const,
    // Enumeration emits its JSON to this subprocess's captured stdout only.
    PLAYWRIGHT_JSON_OUTPUT_FILE: '',
    PLAYWRIGHT_JSON_OUTPUT_DIR: '',
  }
  const { stdout, stderr } = await execute(process.execPath, [
    path.join(checkout, 'node_modules/@playwright/test/cli.js'),
    ...playwrightArguments(run, { forwardedArgs: [], globalTimeout: 30_000 }),
    '--list',
  ], { cwd: checkout, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  expect(stderr).not.toMatch(/Cannot use 'import\.meta'|Failed to load the ES module|SyntaxError/)
  const report = JSON.parse(stdout) as {
    config: { workers: number; projects: { outputDir: string }[] }
    suites: { file: string; specs: unknown[] }[]
    errors: unknown[]
  }
  expect(report.errors).toEqual([])
  expect(report.suites).toHaveLength(1)
  expect(report.suites[0].file).toBe(path.basename(spec))
  expect(report.suites[0].specs).toHaveLength(1)
  expect(report.config.workers).toBe(1)
  expect(report.config.projects).toHaveLength(1)
  expect(path.resolve(report.config.projects[0].outputDir)).toBe(path.resolve(run.root, 'results'))
  expect(await exists(aggregate)).toBe(false)
}, 35_000)
