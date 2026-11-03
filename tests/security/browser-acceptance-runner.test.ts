import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertCompiledPlatform, assertCompiledPreparation, childEnvironment, classifyResult,
  compiledBuildPlan, compiledPreparationReceipt, exactSpecFilter, isInside, parseArguments, planRuns,
  playwrightArguments, projectStats, runCompiledBrowser, runSequential, validCompiledReceipt,
  validateArtifactRoot, validateOrigin,
} from '../../scripts/bulla/browser-acceptance.mjs'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => unknown }
const runnerSource = await readFile(new URL('../../scripts/bulla/browser-acceptance.mjs', import.meta.url), 'utf8')
const browserConfig = await readFile(new URL('../../playwright.config.mts', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}
const workflow = load(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, { steps: { run?: string; uses?: string; with?: { path?: string } }[] }>
}
const inventory = ['tests/e2e/core-campus.spec.ts', 'tests/e2e/people-discovery.spec.ts']
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const aggregateRoot = path.join(path.parse(checkout).root, 'synthetic-browser-reports', 'aggregate')

describe('sequential browser acceptance selection and fresh state', () => {
  it('selects all discovered specs by default without importing the specs', () => {
    expect(parseArguments([], inventory).specs).toEqual(inventory)
  })

  it('preserves single-spec --workers=1 CLI usage and deduplicates repeated selections', () => {
    expect(parseArguments([
      inventory[0], '--workers=1', '--retries=0', 'core-campus.spec.ts',
    ], inventory).specs).toEqual([inventory[0]])
    expect(parseArguments(['people-discovery.spec.ts', '-j', '1', '-g', 'reload'], inventory))
      .toMatchObject({ specs: [inventory[1]], forwardedArgs: ['--grep=reload'] })
  })

  it('accepts an exact checked-out absolute spec, not another checkout or a regex', () => {
    expect(parseArguments([path.join(checkout, inventory[0])], inventory).specs).toEqual([inventory[0]])
    for (const value of ['../core-campus.spec.ts', 'core.*', 'tests/e2e/../owner.spec.ts']) {
      expect(() => parseArguments([value], inventory)).toThrow('unsupported-spec-selection')
    }
  })

  it.each([
    '--workers=2', '--retries=1', '--repeat-each=2', '--config=owner.config.ts',
    '--output=/owner', '--reporter=html', '--trace=on', '--ui', '--debug',
    '--shard=1/2', '--pass-with-no-tests', '--last-failed', '--ignore-snapshots',
    '--update-snapshots=all', '--test-list=owner.txt', '--timeout=0',
  ])('refuses unsafe or acceptance-bypassing option %s', option => {
    expect(() => parseArguments([option], inventory)).toThrow('unsupported-arguments')
  })

  it('generates distinct child roots, run IDs, media directories and ports for every spec', () => {
    const runs = planRuns(inventory, aggregateRoot, 3301, () => 'synthetic-id')
    expect(new Set(runs.map(run => run.id)).size).toBe(2)
    expect(new Set(runs.map(run => run.root)).size).toBe(2)
    expect(runs.map(run => run.origin)).toEqual(['http://127.0.0.1:3301', 'http://127.0.0.1:3302'])
    for (const run of runs) {
      expect(isInside(aggregateRoot, run.root)).toBe(true)
      expect(isInside(run.fixtureRoot, run.mediaRoot)).toBe(true)
      expect(run.status).toBe('pending')
    }
    expect(planRuns(inventory, aggregateRoot, 2999, () => 'synthetic-id').map(run => run.origin))
      .toEqual(['http://127.0.0.1:2999', 'http://127.0.0.1:3001'])
    expect(() => planRuns(inventory, aggregateRoot, 65535)).toThrow('unsafe-origin')
  })

  it('keeps accepted underscore and long spec filenames selectable with valid bounded child IDs', () => {
    const specs = [
      'tests/e2e/nested/synthetic_private-images.spec.ts',
      `tests/e2e/${'synthetic'.repeat(20)}.spec.ts`,
    ]
    expect(parseArguments(specs, specs).specs).toEqual(specs)
    const runs = planRuns(specs, aggregateRoot, 3301, () => '12345678-1234-4234-8234-123456789abc')
    expect(runs.map(run => run.spec)).toEqual(specs)
    for (const run of runs) {
      expect(run.id).toMatch(/^[a-zA-Z0-9-]{1,128}$/)
      expect(new RegExp(exactSpecFilter(run.spec)).test(path.join(checkout, run.spec))).toBe(true)
    }
  })

  it('anchors one escaped absolute file filter and fixes the harness/worker/report contract', () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const filter = new RegExp(exactSpecFilter(run.spec))
    expect(filter.test(path.join(checkout, inventory[0]))).toBe(true)
    expect(filter.test(path.join(checkout, inventory[1]))).toBe(false)
    expect(filter.test(`${path.join(checkout, inventory[0])}.backup`)).toBe(false)
    const args = playwrightArguments(run, { forwardedArgs: [], globalTimeout: 1_800_000 })
    expect(args).toContain(`--config=${path.join(checkout, 'playwright.config.mts')}`)
    for (const option of [
      '--workers=1', '--retries=0', '--repeat-each=1', '--no-deps', '--reporter=json',
      '--trace=off', '--forbid-only', '--fail-on-flaky-tests', '--update-snapshots=none', '--run-agents=none',
    ]) expect(args).toContain(option)
    expect(args[args.length - 1]).toBe(`/${exactSpecFilter(run.spec)}/`)
  })

  it('uses Playwright’s explicit flagless literal branch so case-only spec names cannot run together', () => {
    const specs = ['tests/e2e/synthetic-case.spec.ts', 'tests/e2e/Synthetic-Case.spec.ts']
    for (const run of planRuns(specs, aggregateRoot, 3301)) {
      const args = playwrightArguments(run, { forwardedArgs: [], globalTimeout: 1_800_000 })
      // Installed 1.62.1 forceRegExp recognizes this literal; bare patterns
      // instead receive "gi". Do not import Playwright or launch a runner.
      const literal = /^\/(.*)\/([gi]*)$/.exec(args[args.length - 1])
      expect(literal).not.toBeNull()
      if (!literal) throw new Error('Expected an explicit file-filter literal')
      expect(literal[2]).toBe('')
      const filter = new RegExp(literal[1], literal[2])
      expect(filter.test(path.join(checkout, run.spec))).toBe(true)
      expect(filter.test(path.join(checkout, specs.find(spec => spec !== run.spec)!))).toBe(false)
    }
  })

  it('awaits each spec and checkpoint before the next spec, continuing ordinary failures', async () => {
    const runs = planRuns(inventory, aggregateRoot, 3301)
    const events: string[] = []
    let active = 0
    await runSequential(runs, async run => {
      active++
      expect(active).toBe(1)
      events.push(`start:${run.spec}`)
      await Promise.resolve()
      events.push(`end:${run.spec}`)
      active--
      return { status: run.spec === inventory[0] ? 'failed' : 'passed', reason: 'synthetic-test-result', stop: false }
    }, async () => { events.push('checkpoint') }, new AbortController().signal)
    expect(events).toEqual([
      'checkpoint', `start:${inventory[0]}`, `end:${inventory[0]}`, 'checkpoint',
      'checkpoint', `start:${inventory[1]}`, `end:${inventory[1]}`, 'checkpoint', 'checkpoint',
    ])
    expect(runs.map(run => run.status)).toEqual(['failed', 'passed'])
  })

  it('does not start another spec after a port/teardown safety failure or an interruption', async () => {
    const runs = planRuns(inventory, aggregateRoot, 3301)
    let executed = 0
    await runSequential(runs, async () => {
      executed++
      return { status: 'failed', reason: 'teardown-incomplete', stop: true }
    }, async () => {}, new AbortController().signal)
    expect(executed).toBe(1)
    expect(runs[1]).toMatchObject({ status: 'not-run', reason: 'safety-stop' })
    const abort = new AbortController()
    abort.abort()
    const interrupted = planRuns(inventory, aggregateRoot, 3301)
    await runSequential(interrupted, async () => { throw new Error('must not execute') }, async () => {}, abort.signal)
    expect(interrupted.every(run => run.status === 'not-run' && run.reason === 'interrupted')).toBe(true)
  })
})

describe('browser acceptance safety fences and private evidence', () => {
  it.each([
    'http://127.0.0.1:3000', 'http://example.test:3301', 'https://127.0.0.1:3301',
    'http://user:password@127.0.0.1:3301', 'http://127.0.0.1', 'http://127.0.0.1:80',
    'http://127.0.0.1:3301/feed', 'http://127.0.0.1:3301/?fixture=owner', 'http://127.0.0.1:3301/#owner',
  ])('rejects owner, cloud and ambiguous origin %s', value => {
    expect(() => validateOrigin(value)).toThrow('unsafe-origin')
  })

  it('canonicalizes an explicit localhost/IPv6 request to the IPv4 loopback webServer', () => {
    expect(validateOrigin('http://localhost:3301')).toEqual({ origin: 'http://127.0.0.1:3301', port: 3301 })
    expect(validateOrigin('http://[::1]:3302')).toEqual({ origin: 'http://127.0.0.1:3302', port: 3302 })
  })

  it('fences Windows artifacts to the specified D-drive recovery task, never owner/checkout paths', () => {
    const options = { platform: 'win32', checkout: 'E:/Uni-Social-Network', home: 'C:/Users/Synthetic', temp: 'C:/Temp' }
    const allowed = 'D:/All tasks + Automations/Bulla-Recovery/e2e'
    expect(validateArtifactRoot(allowed, options)).toBe(path.win32.resolve(allowed))
    for (const value of [
      'D:/', 'D:/Quad/site-data', 'D:/All tasks + Automations/Bulla-Recovery/../owner',
      'D:/All tasks + Automations/Bulla-Recovery/.. /owner',
      'D:/All tasks + Automations/Bulla-Recovery/e2e:owner',
      'E:/Uni-Social-Network/e2e', 'C:/Users/Synthetic', 'relative/e2e',
    ]) expect(() => validateArtifactRoot(value, options)).toThrow('unsafe-artifact-root')
  })

  it('allows a dedicated Linux task directory but rejects broad roots and checkout overlap', () => {
    const options = { platform: 'linux', checkout: '/work/bulla', home: '/home/synthetic', temp: '/tmp' }
    expect(validateArtifactRoot('/tmp/bulla-ci-browser', options)).toBe('/tmp/bulla-ci-browser')
    for (const value of ['/', '/tmp', '/home', '/home/synthetic', '/work', '/work/bulla/results']) {
      expect(() => validateArtifactRoot(value, options)).toThrow('unsafe-artifact-root')
    }
  })

  it('drops inherited secrets, source/proxy/report overrides and pins isolated data/media/provider settings', () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const env = childEnvironment({
      PATH: '/synthetic/bin', CI: 'true', NODE_OPTIONS: '--require=owner.js', UNRELATED_PASSWORD: 'DO_NOT_FORWARD',
      SUPABASE_SERVICE_ROLE_KEY: 'DO_NOT_FORWARD', LOCAL_DATA_PATH: '/owner/local.json',
      BULLA_LOCAL_MEDIA_ROOT: '/owner/media', BULLA_ACCOUNT_CLEANUP_ENABLED: '1',
      PLAYWRIGHT_HTML_OUTPUT_DIR: '/owner', PLAYWRIGHT_JSON_OUTPUT_FILE: '/owner/raw.json',
      BULLA_E2E_USE_RUNNING_SERVER: '1', HTTPS_PROXY: 'https://user:password@example.test',
    }, run, '.next-bulla-e2e')
    expect(JSON.stringify(env)).not.toContain('DO_NOT_FORWARD')
    expect(env.NODE_OPTIONS).toBe('')
    expect(env).not.toHaveProperty('PLAYWRIGHT_HTML_OUTPUT_DIR')
    expect(env.LOCAL_DATA_PATH).toBe(path.join(run.fixtureRoot, 'local.json'))
    expect(env.BULLA_LOCAL_MEDIA_ROOT).toBe(run.mediaRoot)
    expect(env.BULLA_E2E_RUN_ID).toBe(run.id)
    expect(env.BULLA_E2E_ARTIFACT_DIR).toBe(path.dirname(run.root))
    expect(env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(path.join(run.root, 'private', 'playwright.json'))
    expect(env.BULLA_E2E_USE_RUNNING_SERVER).toBe('0')
    expect(env.BULLA_ACCOUNT_CLEANUP_ENABLED).toBe('0')
    expect(env.NEXT_PUBLIC_DATA_MODE).toBe('local')
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('')
    expect(env.HTTPS_PROXY).toBe('')
    expect(browserConfig).toContain("BULLA_LOCAL_MEDIA_ROOT: path.join(runRoot, 'fixture', 'media')")
    expect(() => childEnvironment({}, run, '.next')).toThrow('unsafe-runtime-option')
    expect(() => childEnvironment({}, run, '.next-bulla-preview')).toThrow('unsafe-runtime-option')
  })

  it('projects numeric counts only, never raw report configuration, errors, titles or attachments', () => {
    const report = {
      stats: { expected: 2, unexpected: 1, skipped: 0, flaky: 0, duration: 123.4, secret: 'DO_NOT_UPLOAD' },
      config: { env: { secret: 'DO_NOT_UPLOAD' } },
      errors: [{ message: 'DO_NOT_UPLOAD', stack: 'DO_NOT_UPLOAD' }],
      suites: [{ title: 'DO_NOT_UPLOAD', stdout: ['DO_NOT_UPLOAD'], attachments: [{ body: 'DO_NOT_UPLOAD' }] }],
    }
    expect(projectStats(report)).toEqual({ expected: 2, unexpected: 1, skipped: 0, flaky: 0, errors: 1, duration: 123 })
    expect(JSON.stringify(projectStats(report))).not.toContain('DO_NOT_UPLOAD')
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, '1']) {
      expect(() => projectStats({ ...report, stats: { ...report.stats, expected: value } })).toThrow('invalid-report')
    }
  })

  it('keeps development as the default and permits compiled JSON only for a generated loopback fixture', () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const inherited = {
      BULLA_E2E_SERVER_MODE: 'production', BULLA_ALLOW_LOCAL_IN_PRODUCTION: '1',
      QUAD_ALLOW_LOCAL_IN_PRODUCTION: '1', NODE_ENV: 'production',
    }
    const development = childEnvironment(inherited, run, '.next-bulla-e2e')
    expect(development.NODE_ENV).toBe('development')
    expect(development.BULLA_E2E_SERVER_MODE).toBe('development')
    expect(development.BULLA_ALLOW_LOCAL_IN_PRODUCTION).toBe('0')
    const compiled = childEnvironment(inherited, run, '.next-bulla-e2e', 'chrome', 'production')
    expect(compiled.NODE_ENV).toBe('production')
    expect(compiled.BULLA_E2E_SERVER_MODE).toBe('production')
    expect(compiled.BULLA_ALLOW_LOCAL_IN_PRODUCTION).toBe('1')
    expect(compiled.QUAD_ALLOW_LOCAL_IN_PRODUCTION).toBe('0')
    expect(compiled.BULLA_E2E_USE_RUNNING_SERVER).toBe('0')
    expect(compiled.NEXT_PUBLIC_DATA_MODE).toBe('local')
    expect(compiled.SUPABASE_SERVICE_ROLE_KEY).toBe('')
    expect(compiled.BULLA_ACCOUNT_CLEANUP_ENABLED).toBe('0')
    expect(() => childEnvironment({}, run, '.next-bulla-e2e', '', 'preview')).toThrow('unsafe-runtime-option')
    for (const changed of [
      { origin: 'http://127.0.0.1:3000' }, { origin: 'https://example.test:3301' },
      { origin: 'http://localhost:3301' }, { fixtureRoot: '/owner' }, { mediaRoot: '/owner' },
      { id: '../owner' },
    ]) {
      expect(() => childEnvironment({}, { ...run, ...changed }, '.next-bulla-e2e', 'chrome', 'production')).toThrow()
    }
  })

  it('rebuilds before privacy inspection with a nonempty fake canary and never enables serving during compilation', () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const canary = 'synthetic-browser-only-canary-never-a-real-key'
    const stages = compiledBuildPlan(run, '.next-bulla-e2e', canary)
    expect(stages.map(stage => stage.stage)).toEqual(['production-build', 'build-privacy'])
    expect(stages[0].args).toEqual([path.join(checkout, 'node_modules/next/dist/bin/next'), 'build'])
    expect(stages[0].env).toMatchObject({
      SUPABASE_SERVICE_ROLE_KEY: canary, BULLA_BUILD_SECRET_CANARY: '',
      BULLA_ALLOW_LOCAL_IN_PRODUCTION: '0',
    })
    expect(stages[1].args).toEqual([
      path.join(checkout, 'scripts/bulla/check-build.mjs'),
      path.join(checkout, '.next-bulla-e2e'), path.join(run.root, 'build-privacy.md'),
    ])
    expect(stages[1].env).toMatchObject({
      SUPABASE_SERVICE_ROLE_KEY: '', BULLA_BUILD_SECRET_CANARY: canary,
      BULLA_ALLOW_LOCAL_IN_PRODUCTION: '0',
    })
    expect(() => compiledBuildPlan(run, '.next', canary)).toThrow('unsafe-runtime-option')
    for (const value of ['', 'too-short', `${canary}\n`]) {
      expect(() => compiledBuildPlan(run, '.next-bulla-e2e', value)).toThrow('unsafe-build-canary')
    }
    expect(browserConfig).toContain("serverMode === 'production' ? 'start' : 'dev'")
    expect(browserConfig).toContain('Compiled browser testing requires the fresh local-only runner')
    expect(browserConfig).toContain('timeout: 120_000')
    expect(browserConfig).toContain('navigationTimeout: 60_000')
    const preparationAt = runnerSource.indexOf('for (const stage of stages)')
    const launchAt = runnerSource.indexOf('return { outcome: await launch()')
    expect(preparationAt).toBeGreaterThanOrEqual(0)
    expect(launchAt).toBeGreaterThanOrEqual(0)
    expect(preparationAt).toBeLessThan(launchAt)
  })

  it('requires owned preparation in the real config and refuses compiled platforms with unaccepted build-tree teardown', () => {
    expect(() => assertCompiledPlatform('win32')).not.toThrow()
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(() => assertCompiledPlatform(platform)).toThrow('compiled-mode-unavailable-on-platform')
    }
    expect(browserConfig).toContain("if (serverMode === 'production') assertCompiledPreparation(process.env)")
    expect(browserConfig.indexOf('assertCompiledPreparation(process.env)'))
      .toBeLessThan(browserConfig.indexOf("BULLA_ALLOW_LOCAL_IN_PRODUCTION: serverMode"))
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const env = childEnvironment({ BULLA_E2E_PREPARATION_KEY: 'DO_NOT_FORWARD' }, run, '.next-bulla-e2e', 'chrome', 'production')
    expect(env.BULLA_E2E_PREPARATION_KEY).toBe('')
    expect(() => assertCompiledPreparation(env)).toThrow()
    expect(() => assertCompiledPreparation({ ...env, BULLA_E2E_PREPARATION_KEY: 'a'.repeat(64) })).toThrow()
  })

  it('binds the private preparation receipt to the current run/origin/build/report/key and refuses stale/malformed receipts', () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const key = 'a'.repeat(64)
    const digest = 'b'.repeat(64)
    const now = 1_800_000
    const receipt = compiledPreparationReceipt(run, '.next-bulla-e2e', 'synthetic-build-id', digest, key, now)
    expect(JSON.stringify(receipt)).not.toContain(key)
    expect(validCompiledReceipt(receipt, run, '.next-bulla-e2e', 'synthetic-build-id', digest, key, now)).toBe(true)
    for (const changed of [
      null, [], { ...receipt, runId: 'another-run' }, { ...receipt, origin: 'http://127.0.0.1:3302' },
      { ...receipt, buildId: 'old-build' }, { ...receipt, artifactDigest: 'c'.repeat(64) },
      { ...receipt, keyHash: 'd'.repeat(64) }, { ...receipt, preparedAt: now + 1 },
      { ...receipt, preparedAt: now - 20 * 60_000 - 1 }, { ...receipt, preparedAt: 0.5 },
      { ...receipt, preparedAt: Number.NaN }, { ...receipt, extra: true },
      Object.create(receipt),
    ]) {
      expect(validCompiledReceipt(changed, run, '.next-bulla-e2e', 'synthetic-build-id', digest, key, now)).toBe(false)
    }
    expect(validCompiledReceipt(receipt, run, '.next-bulla-e2e', 'synthetic-build-id', digest, 'f'.repeat(64), now)).toBe(false)
  })

  it('awaits both compiled stages before launch and never launches on a failed/aborted/throwing preparation', async () => {
    const run = planRuns([inventory[0]], aggregateRoot, 3301)[0]
    const stages = compiledBuildPlan(run, '.next-bulla-e2e', 'synthetic-nonempty-compiled-canary')
    const events: string[] = []
    const pass = await runCompiledBrowser(stages, async (stage: { stage: string }) => {
      events.push(stage.stage)
      await Promise.resolve()
      return { exitCode: 0 }
    }, async () => { events.push('launch'); return { exitCode: 0 } }, new AbortController().signal)
    expect(events).toEqual(['production-build', 'build-privacy', 'launch'])
    expect(pass).toMatchObject({ outcome: { exitCode: 0 }, preparationFailure: null })

    for (const failure of [
      { exitCode: 1 }, { exitCode: null, spawnFailed: true },
      { exitCode: 0, incomplete: true }, { exitCode: null, interruption: 'interrupted' },
    ]) {
      let launches = 0
      const result = await runCompiledBrowser(stages, async () => failure, async () => { launches++; return { exitCode: 0 } }, new AbortController().signal)
      expect(launches).toBe(0)
      expect(result.preparationFailure).toMatchObject({ status: 'failed', stop: true, stats: { expected: 0 } })
    }
    const aborted = new AbortController()
    let launches = 0
    const result = await runCompiledBrowser(stages, async () => {
      aborted.abort()
      return { exitCode: 0 }
    }, async () => { launches++; return { exitCode: 0 } }, aborted.signal)
    expect(launches).toBe(0)
    expect(result.preparationFailure?.reason).toBe('interrupted')
    const thrown = await runCompiledBrowser(stages, async () => { throw new Error('synthetic-private-error') },
      async () => { launches++; return { exitCode: 0 } }, new AbortController().signal)
    expect(launches).toBe(0)
    expect(thrown.preparationFailure?.reason).toBe('production-build-failed')
    expect(JSON.stringify(thrown)).not.toContain('synthetic-private-error')
  })

  it('cannot turn no tests, only skips, malformed reports, nonzero exits or flaky/error counts into acceptance', () => {
    const stats = { expected: 2, unexpected: 0, skipped: 0, flaky: 0, errors: 0, duration: 123 }
    expect(classifyResult({ exitCode: 0 }, stats)).toMatchObject({ status: 'passed', stop: false })
    for (const changed of [
      { expected: 0 }, { expected: 0, skipped: 2 }, { unexpected: 1 }, { flaky: 1 }, { errors: 1 },
    ]) expect(classifyResult({ exitCode: 0 }, { ...stats, ...changed }).status).toBe('failed')
    expect(classifyResult({ exitCode: 1 }, stats).status).toBe('failed')
    expect(classifyResult({ exitCode: 0 }, stats, 'invalid-report').status).toBe('failed')
    expect(classifyResult({ exitCode: 0 }, stats, 'invalid-report-scope')).toMatchObject({ status: 'failed', stop: true })
    expect(classifyResult({ exitCode: 0 }, stats, 'passed', false)).toMatchObject({ reason: 'teardown-incomplete', stop: true })
    expect(classifyResult({ exitCode: null, interruption: 'interrupted' }, stats)).toMatchObject({ status: 'failed', stop: true })
  })

  it('routes npm/CI through the runner and uploads only aggregate/per-spec sanitized projections', () => {
    expect(packageJson.scripts['test:e2e']).toBe('node scripts/bulla/browser-acceptance.mjs')
    const steps = workflow.jobs.e2e.steps
    expect(steps.some(step => step.run === 'npm run test:e2e')).toBe(true)
    const paths = steps.find(step => step.uses === 'actions/upload-artifact@v4')?.with?.path?.trim().split('\n')
    expect(paths).toHaveLength(4)
    expect(paths?.every(value => /\/(?:REPORT\.md|results\.json|summary\.json)$/.test(value))).toBe(true)
    expect(paths?.join('\n')).not.toMatch(/private\/|fixture|media|\.png|trace|report\/|\.env|\.zip/i)
  })

  it('keeps import-time side effects gated and never discovers/kills an owner listener', () => {
    expect(runnerSource).toContain('if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url)))')
    expect(runnerSource).toContain("await freshDirectory(root) // Refuse an existing ID")
    expect(runnerSource).toContain("['/PID', String(child.pid), '/T', '/F']")
    expect(runnerSource).toContain('shell: false, windowsHide: true')
    expect(runnerSource).not.toMatch(/execSync|spawnSync|reuseExistingServer:\s*true|fs\.rm\(|fs\.unlink\(|fs\.writeFile\([^)]*local\.json|process\.kill\(-/)
  })
})
