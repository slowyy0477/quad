/**
 * One Playwright invocation, fresh datastore/media root and server per spec.
 * No installs, owner-server reuse, fixture resets or hosted provider access.
 *
 * Verifier entry point: node scripts/bulla/browser-acceptance.mjs
 * Single spec: npm run test:e2e -- tests/e2e/core-campus.spec.ts --workers=1
 * BULLA_E2E_SERVER_MODE=production rebuilds/checks a private compiled app before
 * each spec. The default is development; neither mode can serve hosted data.
 * BULLA_E2E_RUN_ID names the aggregate; generated child IDs are never reused.
 * Only REPORT.md/results.json and specs/<id>/REPORT.md/summary.json are public
 * evidence. Raw reporter output, screenshots, inputs and logs remain private.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, promises as fs, lstatSync, readFileSync, realpathSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const specPattern = /^tests\/e2e\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.spec\.(?:[cm]?[jt]s|[jt]sx)$/
const runPattern = /^[a-zA-Z0-9-]{1,128}$/
const distNames = new Set(['.next-bulla-e2e', '.next-bulla-ci-browser', '.next-bulla-verify'])
const serverModes = new Set(['development', 'production'])
const defaultGlobalTimeout = 30 * 60_000
const maxReportBytes = 32 * 1024 * 1024
const countNames = ['expected', 'unexpected', 'skipped', 'flaky', 'errors']
/**
 * @typedef {{ expected: number, unexpected: number, skipped: number, flaky: number, errors: number, duration: number }} RunStats
 * @typedef {{ spec: string, id: string, root: string, fixtureRoot: string, mediaRoot: string, origin: string,
 *   status: 'pending' | 'running' | 'passed' | 'failed' | 'not-run', reason: string, stats: RunStats,
 *   startedAt: string | null, finishedAt: string | null, exitCode: number | null, serverMode?: string }} SpecRun
 * @typedef {{ status: 'passed' | 'failed', reason: string, stop?: boolean, stats?: RunStats, exitCode?: number | null }} SpecResult
 */
const zeroStats = () => ({ expected: 0, unexpected: 0, skipped: 0, flaky: 0, errors: 0, duration: 0 })

class RunnerError extends Error {
  constructor(reason) {
    // Never interpolate rejected arguments, paths, credentials or raw errors.
    super(reason)
    this.reason = reason
  }
}

function samePath(left, right, api = path) {
  const a = api.resolve(left)
  const b = api.resolve(right)
  return api === path.win32 ? a.toLowerCase() === b.toLowerCase() : a === b
}

function hasControls(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

export function isInside(root, target, api = path) {
  const relative = api.relative(api.resolve(root), api.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)
}

/**
 * @param {string} value
 * @param {{ platform?: string, checkout?: string, home?: string, temp?: string }} [options]
 */
export function validateArtifactRoot(value, options = {}) {
  const { platform = process.platform, checkout = projectRoot, home = os.homedir(), temp = os.tmpdir() } = options
  const api = platform === 'win32' ? path.win32 : path.posix
  if (typeof value !== 'string' || hasControls(value) || !api.isAbsolute(value)) {
    throw new RunnerError('unsafe-artifact-root')
  }
  const root = api.resolve(value)
  if (platform === 'win32' && root.slice(api.parse(root).root.length).split(api.sep).some(segment =>
    /[. ]$|[<>:"|?*]/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
  )) throw new RunnerError('unsafe-artifact-root')
  if ([api.parse(root).root, home, temp, checkout].some(forbidden =>
    samePath(root, forbidden, api) || isInside(root, forbidden, api),
  ) || isInside(checkout, root, api)) throw new RunnerError('unsafe-artifact-root')
  if (platform === 'win32' && !isInside(recoveryRoot, root, api)) {
    throw new RunnerError('unsafe-artifact-root')
  }
  return root
}

export function validateOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new RunnerError('unsafe-origin') }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.username || url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' || url.search || url.hash ||
      !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    throw new RunnerError('unsafe-origin')
  }
  // The checked-in webServer binds IPv4; localhost must not resolve to ::1.
  return { origin: `http://127.0.0.1:${port}`, port }
}

/**
 * @param {string[]} args
 * @param {string[]} inventory
 */
export function parseArguments(args, inventory) {
  if (!inventory.length || inventory.some(spec => !specPattern.test(spec))) {
    throw new RunnerError('invalid-spec-inventory')
  }
  const selected = []
  const forwardedArgs = []
  const seenFlags = new Set()
  let globalTimeout = defaultGlobalTimeout
  let positionalOnly = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--' && !positionalOnly) { positionalOnly = true; continue }
    if (!positionalOnly && argument.startsWith('-')) {
      const equals = argument.indexOf('=')
      const original = equals === -1 ? argument : argument.slice(0, equals)
      const flag = ({ '-j': '--workers', '-g': '--grep', '-G': '--grep-invert' })[original] || original
      if (!['--workers', '--retries', '--grep', '--grep-invert', '--timeout', '--global-timeout'].includes(flag) ||
          seenFlags.has(flag)) throw new RunnerError('unsupported-arguments')
      seenFlags.add(flag)
      const value = equals === -1 ? args[++index] : argument.slice(equals + 1)
      if (!value || hasControls(value)) throw new RunnerError('unsupported-arguments')
      if (flag === '--workers' || flag === '--retries') {
        if (value !== (flag === '--workers' ? '1' : '0')) throw new RunnerError('unsupported-arguments')
      } else if (flag === '--grep' || flag === '--grep-invert') {
        if (value.length > 512) throw new RunnerError('unsupported-arguments')
        try { new RegExp(value) } catch { throw new RunnerError('unsupported-arguments') }
        forwardedArgs.push(`${flag}=${value}`)
      } else {
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > defaultGlobalTimeout) {
          throw new RunnerError('unsupported-arguments')
        }
        if (flag === '--global-timeout') globalTimeout = Number(value)
        else forwardedArgs.push(`${flag}=${value}`)
      }
      continue
    }
    let spec = argument.replace(/\\/g, '/').replace(/^\.\//, '')
    if (path.isAbsolute(argument)) spec = path.relative(projectRoot, argument).split(path.sep).join('/')
    const matches = spec === 'tests/e2e' ? inventory : inventory.filter(candidate =>
      candidate === spec || (!spec.includes('/') && path.posix.basename(candidate) === spec),
    )
    if (!matches.length || (spec !== 'tests/e2e' && matches.length !== 1)) {
      throw new RunnerError('unsupported-spec-selection')
    }
    selected.push(...matches)
  }
  return { specs: [...new Set(selected.length ? selected : inventory)], forwardedArgs, globalTimeout }
}

/**
 * @param {string[]} specs
 * @param {string} aggregateRoot
 * @param {number} firstPort
 * @param {() => string} [uuid]
 * @returns {SpecRun[]}
 */
export function planRuns(specs, aggregateRoot, firstPort, uuid = randomUUID) {
  let port = firstPort
  return specs.map((spec, index) => {
    if (!specPattern.test(spec)) throw new RunnerError('invalid-spec-inventory')
    if (port === 3000) port++
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RunnerError('unsafe-origin')
    // Spec names may contain underscores or exceed the run-ID length fence.
    // IDs use a bounded slug; the full file path still selects the exact spec.
    const label = path.posix.basename(spec).split('.spec.')[0].replace(/_/g, '-').slice(0, 48)
    const id = `spec-${String(index + 1).padStart(2, '0')}-${label}-${uuid()}`
    if (!runPattern.test(id)) throw new RunnerError('invalid-run-id')
    const root = path.join(aggregateRoot, 'specs', id)
    const fixtureRoot = path.join(root, 'fixture')
    return {
      spec, id, root, fixtureRoot, origin: `http://127.0.0.1:${port++}`,
      mediaRoot: path.join(fixtureRoot, 'media'),
      status: 'pending', reason: 'pending', stats: zeroStats(),
      startedAt: null, finishedAt: null, exitCode: null,
    }
  })
}

export function exactSpecFilter(spec, checkout = projectRoot) {
  if (!specPattern.test(spec)) throw new RunnerError('invalid-spec-inventory')
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^${path.resolve(checkout, ...spec.split('/')).split(/[/\\]/).map(escape).join('[\\\\/]')}$`
}

/**
 * @param {SpecRun} run
 * @param {{ globalTimeout: number, forwardedArgs: string[] }} options
 */
export function playwrightArguments(run, options) {
  return [
    'test', `--config=${path.join(projectRoot, 'playwright.config.mts')}`,
    '--workers=1', '--retries=0', '--repeat-each=1', '--no-deps',
    '--forbid-only', '--fail-on-flaky-tests', '--reporter=json', '--trace=off',
    '--update-snapshots=none', '--run-agents=none',
    `--global-timeout=${options.globalTimeout}`, ...options.forwardedArgs,
    // Playwright forceRegExp gives bare patterns "gi". The literal form with
    // no flags keeps case-only filenames distinct on case-sensitive systems.
    `/${exactSpecFilter(run.spec)}/`,
  ]
}

/**
 * @param {Record<string, string | undefined>} inherited
 * @param {SpecRun} run
 * @param {string} distName
 * @param {string} [browser]
 * @param {string} [serverMode]
 * @returns {Record<string, string>}
 */
export function childEnvironment(inherited, run, distName, browser = '', serverMode = 'development') {
  if (!distNames.has(distName) || !['', 'chrome', 'msedge', 'chromium'].includes(browser) ||
      !serverModes.has(serverMode)) {
    throw new RunnerError('unsafe-runtime-option')
  }
  // The compiled private-review exception is never derived from inherited
  // settings. Recheck the generated origin and contained fixture before it can
  // be assigned; the runner separately verifies physical paths and freshness.
  const checkedOrigin = validateOrigin(run.origin).origin
  if (checkedOrigin !== run.origin || !runPattern.test(run.id) ||
      !samePath(run.root, path.join(path.dirname(run.root), run.id)) ||
      !isInside(run.root, run.fixtureRoot) || !isInside(run.fixtureRoot, run.mediaRoot)) {
    throw new RunnerError('unsafe-runtime-option')
  }
  // Do not forward NODE_OPTIONS, credentials, proxy/debug/report overrides,
  // cleanup-worker switches, owner fixture/media paths or npm script options.
  const systemKeys = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH',
  ])
  const env = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (systemKeys.has(key.toUpperCase()) && typeof value === 'string') env[key.toUpperCase()] = value
  }
  if (inherited.CI === 'true' || inherited.CI === '1') env.CI = 'true'
  return {
    ...env, NODE_ENV: serverMode, NODE_OPTIONS: '', NODE_PATH: '', PWDEBUG: '0', DEBUG: '',
    NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
    NEXT_PUBLIC_DATA_MODE: 'local', NEXT_PUBLIC_SITE_URL: run.origin,
    NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_ACCESS_TOKEN: '', DATABASE_URL: '',
    LOCAL_DATA_PATH: path.join(run.fixtureRoot, 'local.json'), BULLA_LOCAL_MEDIA_ROOT: run.mediaRoot,
    LOCAL_AUTH_TRUST_PROXY: 'false',
    BULLA_REQUIRE_HTTPS: '0', QUAD_REQUIRE_HTTPS: '0',
    BULLA_ALLOW_LOCAL_IN_PRODUCTION: serverMode === 'production' ? '1' : '0',
    QUAD_ALLOW_LOCAL_IN_PRODUCTION: '0',
    BULLA_ACCOUNT_CLEANUP_ENABLED: '0', BULLA_ACCOUNT_CLEANUP_BUCKETS: '',
    BULLA_RECOVERY_EMAIL_TEMPLATE: '',
    BULLA_E2E_ARTIFACT_DIR: path.dirname(run.root), BULLA_E2E_RUN_ID: run.id,
    BULLA_E2E_BASE_URL: run.origin, BULLA_E2E_DIST_DIR: distName, BULLA_NEXT_DIST_DIR: distName,
    BULLA_E2E_SERVER_MODE: serverMode,
    BULLA_E2E_PREPARATION_KEY: '',
    BULLA_E2E_USE_RUNNING_SERVER: '0', BULLA_E2E_ISOLATED_DATA: '0', BULLA_E2E_BROWSER: browser,
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(run.root, 'private', 'playwright.json'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_GC: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '0',
  }
}

/**
 * Pure, inspectable build plan. Never accept an old build as proof of current
 * source. Both subprocesses run before Playwright can start a fresh server.
 * The nonempty fake canary exists only in child environments, never reports.
 *
 * @param {SpecRun} run
 * @param {string} distName
 * @param {string} canary
 */
export function compiledBuildPlan(run, distName, canary) {
  childEnvironment({}, run, distName, '', 'production')
  if (typeof canary !== 'string' || canary.length < 24 || hasControls(canary)) {
    throw new RunnerError('unsafe-build-canary')
  }
  return [
    {
      stage: 'production-build',
      args: [path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'],
      env: {
        NODE_ENV: 'production',
        // Compilation does not need permission to serve the JSON adapter.
        BULLA_ALLOW_LOCAL_IN_PRODUCTION: '0',
        SUPABASE_SERVICE_ROLE_KEY: canary,
        BULLA_BUILD_SECRET_CANARY: '',
      },
    },
    {
      stage: 'build-privacy',
      args: [
        path.join(projectRoot, 'scripts', 'bulla', 'check-build.mjs'),
        path.join(projectRoot, distName), path.join(run.root, 'build-privacy.md'),
      ],
      env: {
        SUPABASE_SERVICE_ROLE_KEY: '',
        BULLA_ALLOW_LOCAL_IN_PRODUCTION: '0',
        BULLA_BUILD_SECRET_CANARY: canary,
      },
    },
  ]
}

/** @param {string} [platform] Compiled mode uses only the Windows tree-aware path. */
export function assertCompiledPlatform(platform = process.platform) {
  if (platform !== 'win32') throw new RunnerError('compiled-mode-unavailable-on-platform')
}

/**
 * The random handoff key is generated only after a fresh build/privacy pass.
 * Only its digest goes in the private receipt; neither value is public evidence.
 *
 * @param {SpecRun} run
 * @param {string} distName
 * @param {string} buildId
 * @param {string} artifactDigest
 * @param {string} key
 * @param {number} [preparedAt]
 */
export function compiledPreparationReceipt(run, distName, buildId, artifactDigest, key, preparedAt = Date.now()) {
  childEnvironment({}, run, distName, '', 'production')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(buildId) ||
      !/^[a-f0-9]{64}$/.test(artifactDigest) || !/^[a-f0-9]{64}$/.test(key) ||
      !Number.isSafeInteger(preparedAt) || preparedAt < 0) {
    throw new RunnerError('invalid-compiled-preparation')
  }
  return {
    schemaVersion: 1, runId: run.id, origin: run.origin, distName, buildId,
    artifactDigest, preparedAt, keyHash: createHash('sha256').update(key).digest('hex'),
  }
}

/**
 * @param {unknown} receipt
 * @param {SpecRun} run
 * @param {string} distName
 * @param {string} buildId
 * @param {string} artifactDigest
 * @param {string} key
 * @param {number} [now]
 */
export function validCompiledReceipt(receipt, run, distName, buildId, artifactDigest, key, now = Date.now()) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      !Object.hasOwn(receipt, 'preparedAt') || !('preparedAt' in receipt) ||
      typeof receipt.preparedAt !== 'number' || !Number.isSafeInteger(receipt.preparedAt) ||
      receipt.preparedAt < 0 || receipt.preparedAt > now ||
      now - receipt.preparedAt > 20 * 60_000) return false
  const expected = compiledPreparationReceipt(run, distName, buildId, artifactDigest, key, receipt.preparedAt)
  return Reflect.ownKeys(receipt).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, value]) => Object.hasOwn(receipt, name) && receipt[name] === value)
}

function ordinaryAncestorsSync(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(current, realpathSync(current))) {
      throw new RunnerError('unprepared-compiled-server')
    }
    if (current === path.dirname(current)) break
  }
}

function boundedFileSync(target, maxBytes) {
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 ||
      stat.size > maxBytes || !samePath(target, realpathSync(target))) {
    throw new RunnerError('unprepared-compiled-server')
  }
  const bytes = readFileSync(target)
  if (bytes.length > maxBytes) throw new RunnerError('unprepared-compiled-server')
  return bytes
}

/**
 * Called by the real config before granting JSON serving. Matching env strings
 * do not earn the exception: physically verify the owned task paths, empty
 * fixture, current build/report and runner-created private preparation receipt.
 * Read-only; no server launch.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertCompiledPreparation(env) {
  assertCompiledPlatform()
  try {
    const root = env.BULLA_E2E_ARTIFACT_DIR
    const runId = env.BULLA_E2E_RUN_ID
    const distName = env.BULLA_E2E_DIST_DIR
    const key = env.BULLA_E2E_PREPARATION_KEY
    if (!root || !path.isAbsolute(root) || path.basename(root) !== 'specs' ||
        !runId || !runPattern.test(runId) || !distName || !distNames.has(distName) ||
        !key || !/^[a-f0-9]{64}$/.test(key)) throw new RunnerError('unprepared-compiled-server')
    const artifactRoot = validateArtifactRoot(path.dirname(path.dirname(root)))
    const runRoot = path.join(root, runId)
    const fixtureRoot = path.join(runRoot, 'fixture')
    const mediaRoot = path.join(fixtureRoot, 'media')
    if (!isInside(artifactRoot, runRoot) || !env.BULLA_E2E_BASE_URL ||
        validateOrigin(env.BULLA_E2E_BASE_URL).origin !== env.BULLA_E2E_BASE_URL ||
        env.LOCAL_DATA_PATH !== path.join(fixtureRoot, 'local.json') ||
        env.BULLA_LOCAL_MEDIA_ROOT !== mediaRoot) throw new RunnerError('unprepared-compiled-server')
    for (const directory of [root, runRoot, fixtureRoot, mediaRoot, path.join(runRoot, 'private')]) {
      ordinaryAncestorsSync(directory)
    }
    const fixtureFile = path.join(fixtureRoot, 'local.json')
    try {
      const snapshot = JSON.parse(boundedFileSync(fixtureFile, 5 * 1024 * 1024).toString('utf8'))
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
          Object.values(snapshot).some(rows => !Array.isArray(rows) || rows.length !== 0)) {
        throw new RunnerError('unprepared-compiled-server')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      lstatSync(`${fixtureFile}.lock`)
      throw new RunnerError('unprepared-compiled-server')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const distPath = path.join(projectRoot, distName)
    const dist = lstatSync(distPath)
    const realDist = realpathSync(distPath)
    if (dist.isSymbolicLink()) {
      const targetName = ({ '.next-bulla-e2e': 'e2e-next', '.next-bulla-verify': 'verify-next' })[distName]
      if (!targetName || !samePath(realDist, path.join(recoveryRoot, 'build', targetName))) {
        throw new RunnerError('unprepared-compiled-server')
      }
      ordinaryAncestorsSync(realDist)
    } else if (!dist.isDirectory() || !samePath(distPath, realDist)) {
      throw new RunnerError('unprepared-compiled-server')
    }
    const buildId = boundedFileSync(path.join(realDist, 'BUILD_ID'), 4096).toString('utf8').trim()
    const report = boundedFileSync(path.join(runRoot, 'build-privacy.md'), 64 * 1024)
    if (!report.toString('utf8').includes('\nResult: Passed\n')) throw new RunnerError('unprepared-compiled-server')
    const receipt = JSON.parse(boundedFileSync(
      path.join(runRoot, 'private', 'compiled-preparation.json'), 8192,
    ).toString('utf8'))
    const run = {
      id: runId, root: runRoot, fixtureRoot, mediaRoot, origin: env.BULLA_E2E_BASE_URL,
    }
    if (!validCompiledReceipt(receipt, run, distName, buildId, createHash('sha256').update(report).digest('hex'), key)) {
      throw new RunnerError('unprepared-compiled-server')
    }
  } catch {
    throw new RunnerError('unprepared-compiled-server')
  }
}

/** Mockable seam; failed/aborted prep never launches a browser on an old build. */
export async function runCompiledBrowser(stages, prepare, launch, signal) {
  for (const stage of stages) {
    if (signal.aborted) {
      return { preparationFailure: { status: 'failed', reason: 'interrupted', exitCode: null, stats: zeroStats(), stop: true } }
    }
    let outcome
    try { outcome = await prepare(stage) } catch {
      return { preparationFailure: { status: 'failed', reason: `${stage.stage}-failed`, exitCode: null, stats: zeroStats(), stop: true } }
    }
    if (!outcome || typeof outcome !== 'object' || outcome.exitCode !== 0 ||
        outcome.spawnFailed || outcome.incomplete || outcome.interruption) {
      return { preparationFailure: {
        status: 'failed', reason: outcome?.incomplete ? 'teardown-incomplete' : outcome?.interruption || `${stage.stage}-failed`,
        exitCode: outcome?.exitCode ?? null, stats: zeroStats(), stop: true,
      } }
    }
  }
  if (signal.aborted) {
    return { preparationFailure: { status: 'failed', reason: 'interrupted', exitCode: null, stats: zeroStats(), stop: true } }
  }
  try {
    return { outcome: await launch(), preparationFailure: null }
  } catch {
    return { preparationFailure: { status: 'failed', reason: 'compiled-launch-failed', exitCode: null, stats: zeroStats(), stop: true } }
  }
}

export function projectStats(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.errors) || !Array.isArray(report.suites) ||
      !report.stats || typeof report.stats !== 'object') throw new RunnerError('invalid-report')
  const stats = zeroStats()
  for (const key of countNames.filter(key => key !== 'errors')) {
    const value = report.stats[key]
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new RunnerError('invalid-report')
    stats[key] = value
  }
  if (!Number.isFinite(report.stats.duration) || report.stats.duration < 0 ||
      report.stats.duration > 7 * 24 * 60 * 60_000 || report.errors.length > 1_000_000) {
    throw new RunnerError('invalid-report')
  }
  stats.duration = Math.round(report.stats.duration)
  stats.errors = report.errors.length
  // Deliberately omit config/env, titles, errors/stacks, stdio and attachments.
  return stats
}

/**
 * @param {{ exitCode: number | null, incomplete?: boolean, interruption?: string, spawnFailed?: boolean }} outcome
 * @param {RunStats} stats
 * @param {string} [reportReason]
 * @param {boolean} [released]
 * @returns {SpecResult}
 */
export function classifyResult(outcome, stats, reportReason = 'passed', released = true) {
  let reason = reportReason
  if (!released || outcome.incomplete) reason = 'teardown-incomplete'
  else if (outcome.interruption) reason = outcome.interruption
  else if (outcome.spawnFailed) reason = 'spawn-failed'
  else if (reason === 'passed') {
    if (outcome.exitCode !== 0) reason = 'playwright-failed'
    else if (stats.unexpected || stats.flaky || stats.errors) reason = 'test-failures'
    else if (stats.expected === 0) reason = 'no-executed-tests'
  }
  return {
    status: reason === 'passed' ? 'passed' : 'failed', reason, stats, exitCode: outcome.exitCode,
    stop: !released || !!outcome.incomplete || !!outcome.interruption || reason === 'invalid-report-scope',
  }
}

/**
 * @param {SpecRun[]} runs
 * @param {(run: SpecRun) => Promise<SpecResult>} execute
 * @param {() => Promise<void>} checkpoint
 * @param {AbortSignal} signal
 */
export async function runSequential(runs, execute, checkpoint, signal) {
  for (const run of runs) {
    if (signal.aborted) break
    run.status = 'running'
    run.reason = 'running'
    run.startedAt = new Date().toISOString()
    await checkpoint()
    if (signal.aborted) {
      run.status = 'not-run'
      run.reason = 'interrupted'
      break
    }
    let result
    try { result = await execute(run) } catch (error) {
      result = { status: 'failed', reason: error instanceof RunnerError ? error.reason : 'runner-error', stop: true }
    }
    Object.assign(run, result, { finishedAt: new Date().toISOString() })
    await checkpoint()
    // Assertion failures continue. An unsafe port/teardown never starts another server.
    if (result.stop) break
  }
  for (const run of runs.filter(run => run.status === 'pending')) {
    run.status = 'not-run'
    run.reason = signal.aborted ? 'interrupted' : 'safety-stop'
  }
  await checkpoint()
}

async function plainAncestors(target) {
  const directories = []
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    directories.unshift(current)
    if (current === path.dirname(current)) break
  }
  for (const directory of directories) {
    let stat
    try { stat = await fs.lstat(directory) } catch (error) {
      if (error.code === 'ENOENT') return
      throw new RunnerError('unsafe-artifact-path')
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(directory, await fs.realpath(directory))) {
      throw new RunnerError('unsafe-artifact-path')
    }
  }
}

async function discoverSpecs() {
  const result = []
  const root = path.join(projectRoot, 'tests', 'e2e')
  await plainAncestors(root)
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new RunnerError('unsafe-spec-path')
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && /\.spec\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
        const relative = path.relative(projectRoot, target).split(path.sep).join('/')
        if (!isInside(root, target) || !specPattern.test(relative)) throw new RunnerError('unsafe-spec-path')
        result.push(relative)
      }
    }
  }
  await visit(root)
  return result.sort()
}

async function validateDist(distName, artifactRoot) {
  if (!distNames.has(distName)) throw new RunnerError('unsafe-runtime-option')
  const distPath = path.join(projectRoot, distName)
  let stat
  try { stat = await fs.lstat(distPath) } catch (error) {
    if (error.code === 'ENOENT') return
    throw new RunnerError('unsafe-dist-path')
  }
  const real = await fs.realpath(distPath)
  if (stat.isSymbolicLink()) {
    // Preserve the existing verifier/e2e task-drive junctions; never accept
    // a link to .next, the owner preview, D:/Quad or an arbitrary build target.
    const targetName = ({ '.next-bulla-e2e': 'e2e-next', '.next-bulla-verify': 'verify-next' })[distName]
    const taskRoot = process.platform === 'win32' ? recoveryRoot : path.dirname(artifactRoot)
    if (!targetName || !samePath(real, path.join(taskRoot, 'build', targetName))) {
      throw new RunnerError('unsafe-dist-path')
    }
    await plainAncestors(real)
  } else if (!stat.isDirectory() || !samePath(real, distPath)) {
    throw new RunnerError('unsafe-dist-path')
  }
}

async function freshDirectory(target, recursive = false) {
  await plainAncestors(target) // Check the target itself before following mkdir.
  try { await fs.mkdir(target, { recursive, mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new RunnerError('run-already-exists')
    throw new RunnerError('artifact-write-failed')
  }
  await plainAncestors(target)
}

async function writeEvidence(target, value) {
  await plainAncestors(path.dirname(target))
  try {
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RunnerError('unsafe-artifact-path')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC |
    (constants.O_NOFOLLOW || 0), 0o600)
  try { await handle.writeFile(value, 'utf8') } finally { await handle.close() }
}

function publicRun(run) {
  return {
    spec: run.spec, runId: run.id, origin: run.origin, status: run.status, reason: run.reason,
    serverMode: run.serverMode || 'development',
    startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode, stats: run.stats,
  }
}

function markdown(id, runs) {
  return [
    '# Bulla — sequential local browser acceptance', '',
    `Run: ${id}`, '',
    `Selected: ${runs.length}; passed: ${runs.filter(run => run.status === 'passed').length}; failed: ${runs.filter(run => run.status === 'failed').length}; not run: ${runs.filter(run => run.status === 'not-run').length}.`, '',
    '| Spec | Child run | Loopback | Runtime | Result | Passed | Failed | Skipped | Flaky | Errors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...runs.map(run => `| ${run.spec} | ${run.runId} | ${run.origin} | ${run.serverMode} | ${run.status} (${run.reason}) | ${run.stats.expected} | ${run.stats.unexpected} | ${run.stats.skipped} | ${run.stats.flaky} | ${run.stats.errors} |`),
    '', '## Scope and privacy', '',
    '- Every selected spec gets a fresh generated run ID, datastore, private media directory and Playwright webServer.',
    '- Execution is sequential: one worker, zero retries/repeats, no running-server reuse and never owner port 3000.',
    '- The dedicated compilation cache can be used serially; it is not shared account/fixture state. Run only one acceptance/verifier command at a time.',
    '- Production mode rebuilds current source and passes the nonempty-canary artifact check before each spec. Its JSON override applies only to the fresh loopback test server, not a public deployment.',
    '- The optional compiled mode currently refuses non-Windows platforms until independent owned-build-tree teardown is implemented/accepted. Default development CI remains unchanged.',
    '- These reports contain only spec paths, generated IDs, loopback origins, own timestamps, fixed outcomes and numeric counts.',
    '- Raw errors/configuration/output, screenshots, traces, HTML, downloads and fixtures are not uploadable evidence. Inspect private/playwright.json and private/process.log locally inside the failed child run.',
    '- A passing local run does not verify hosted providers, staging, recovery, deployment, security clearance or user capacity.',
    '- Next: main reviews failures/private evidence and resolves the first refused or failing step; broader acceptance remains separate.',
    '',
  ].join('\n')
}

async function checkpoint(root, id, runs) {
  const results = runs.map(publicRun)
  const stats = zeroStats()
  for (const run of runs) for (const key of [...countNames, 'duration']) stats[key] += run.stats[key]
  const status = runs.every(run => run.status === 'passed') ? 'passed'
    : runs.some(run => run.status === 'failed' || run.status === 'not-run') ? 'failed' : 'running'
  await writeEvidence(path.join(root, 'results.json'), JSON.stringify({ schemaVersion: 1, runId: id, status, stats, results }, null, 2))
  await writeEvidence(path.join(root, 'REPORT.md'), markdown(id, results))
}

function portAvailable(port) {
  // A temporary bind checks ownership without sending HTTP to an existing app.
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function boundedWait(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds) })])
  } finally { clearTimeout(timer) }
}

async function releasedPort(port) {
  const deadline = Date.now() + 10_000
  do {
    if (await portAvailable(port)) return true
    await delay(100)
  } while (Date.now() < deadline)
  return false
}

async function stopOwnedChild(child, closed) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return closed
  if (process.platform === 'win32') {
    // Only the PID returned by this spawn and its descendants; no port/name
    // lookup, listener deletion, shell-built command or owner process cleanup.
    const taskkill = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', 'System32', 'taskkill.exe')
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    })
    killer.on('error', () => { /* A failed cleanup is caught by the port fence. */ })
  } else {
    try { child.kill('SIGINT') } catch { /* It may already have exited. */ }
  }
  const graceful = await boundedWait(closed, 15_000)
  if (graceful) return graceful
  if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* The port fence still decides safety. */ }
  }
  return boundedWait(closed, 5_000)
}

async function launchOwnedCommand(args, options, env, signal, logFd) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot, env, stdio: ['ignore', logFd, logFd], shell: false, windowsHide: true,
  })
  let spawnFailed = false
  child.on('error', () => { spawnFailed = true })
  const closed = new Promise(resolve => child.once('close', code =>
    resolve({ exitCode: Number.isInteger(code) ? code : null, spawnFailed }),
  ))
  let timer
  let onAbort
  const cancelled = new Promise(resolve => {
    onAbort = () => resolve('interrupted')
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => resolve('watchdog-timeout'), options.globalTimeout + 120_000)
    if (signal.aborted) onAbort()
  })
  const outcome = await Promise.race([closed, cancelled])
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
  if (typeof outcome !== 'string') return outcome
  const stopped = await stopOwnedChild(child, closed)
  return { exitCode: stopped?.exitCode ?? null, spawnFailed, interruption: outcome, incomplete: !stopped }
}

async function readStats(run) {
  const target = path.join(run.root, 'private', 'playwright.json')
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxReportBytes || stat.size === 0) {
    throw new RunnerError('invalid-report')
  }
  let report
  try { report = JSON.parse(await fs.readFile(target, 'utf8')) } catch { throw new RunnerError('invalid-report') }
  const stats = projectStats(report)
  if (report.suites.length) {
    const reportRoot = report.config?.rootDir
    if (typeof reportRoot !== 'string' || !path.isAbsolute(reportRoot) ||
        (!samePath(reportRoot, projectRoot) && !isInside(projectRoot, reportRoot))) {
      throw new RunnerError('invalid-report-scope')
    }
    const expected = path.relative(reportRoot, path.join(projectRoot, ...run.spec.split('/'))).split(path.sep).join('/')
    if (report.suites.length !== 1 || report.suites[0]?.file !== expected) {
      throw new RunnerError('invalid-report-scope')
    }
  } else if (stats.expected + stats.unexpected + stats.flaky + stats.skipped > 0) {
    throw new RunnerError('invalid-report-scope')
  }
  return stats
}

async function executeSpec(run, options, settings, signal) {
  const port = new URL(run.origin).port
  await freshDirectory(run.root)
  await freshDirectory(run.fixtureRoot)
  await freshDirectory(run.mediaRoot)
  await freshDirectory(path.join(run.root, 'private'))
  if (signal.aborted || !await portAvailable(Number(port))) {
    const result = { status: 'failed', reason: signal.aborted ? 'interrupted' : 'port-occupied', stop: true }
    await writeEvidence(path.join(run.root, 'summary.json'), JSON.stringify({ schemaVersion: 1, ...publicRun({ ...run, ...result, finishedAt: new Date().toISOString() }) }, null, 2))
    await writeEvidence(path.join(run.root, 'REPORT.md'), markdown(run.id, [publicRun({ ...run, ...result })]))
    return result
  }
  const rawReport = await fs.open(path.join(run.root, 'private', 'playwright.json'), 'wx', 0o600)
  await rawReport.close()
  const log = await fs.open(path.join(run.root, 'private', 'process.log'), 'wx', 0o600)
  let outcome
  let preparationFailure
  try {
    const env = childEnvironment(process.env, run, settings.distName, settings.browser, settings.serverMode)
    const launch = async () => {
      if (settings.serverMode === 'production') {
        const key = randomBytes(32).toString('hex')
        const realDist = await fs.realpath(path.join(projectRoot, settings.distName))
        const buildId = boundedFileSync(
          path.join(realDist, 'BUILD_ID'), 4096,
        ).toString('utf8').trim()
        const report = boundedFileSync(path.join(run.root, 'build-privacy.md'), 64 * 1024)
        await writeEvidence(path.join(run.root, 'private', 'compiled-preparation.json'), JSON.stringify(
          compiledPreparationReceipt(run, settings.distName, buildId, createHash('sha256').update(report).digest('hex'), key),
        ))
        env.BULLA_E2E_PREPARATION_KEY = key
        assertCompiledPreparation(env)
      }
      return signal.aborted ? { exitCode: null, interruption: 'interrupted' }
        : await launchOwnedCommand([
          path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
          ...playwrightArguments(run, options),
        ], options, env, signal, log.fd)
    }
    if (settings.serverMode === 'production') {
      const canary = `bulla-compiled-browser-canary-${randomUUID()}`
      const prepared = await runCompiledBrowser(
        compiledBuildPlan(run, settings.distName, canary),
        async stage => {
          console.log(`Bulla browser: ${run.spec}: ${stage.stage}`)
          return launchOwnedCommand(stage.args, options, { ...env, ...stage.env }, signal, log.fd)
        },
        launch, signal,
      )
      preparationFailure = prepared.preparationFailure
      outcome = prepared.outcome
    } else {
      outcome = await launch()
    }
  } finally { await log.close() }
  const released = await releasedPort(Number(port))
  if (preparationFailure) {
    const result = released ? preparationFailure : { ...preparationFailure, reason: 'teardown-incomplete' }
    await writeEvidence(path.join(run.root, 'summary.json'), JSON.stringify({
      schemaVersion: 1, ...publicRun({ ...run, ...result, finishedAt: new Date().toISOString() }),
    }, null, 2))
    await writeEvidence(path.join(run.root, 'REPORT.md'), markdown(run.id, [publicRun({ ...run, ...result })]))
    return result
  }
  let stats = zeroStats()
  let reason = 'passed'
  try { stats = await readStats(run) } catch (error) {
    reason = error instanceof RunnerError ? error.reason : 'missing-report'
  }
  const result = classifyResult(outcome, stats, reason, released)
  await writeEvidence(path.join(run.root, 'summary.json'), JSON.stringify({ schemaVersion: 1, ...publicRun({ ...run, ...result, finishedAt: new Date().toISOString() }) }, null, 2))
  await writeEvidence(path.join(run.root, 'REPORT.md'), markdown(run.id, [publicRun({ ...run, ...result })]))
  return result
}

async function main() {
  if (process.env.BULLA_E2E_USE_RUNNING_SERVER && process.env.BULLA_E2E_USE_RUNNING_SERVER !== '0') {
    throw new RunnerError('server-reuse-forbidden')
  }
  const artifactRoot = validateArtifactRoot(process.env.BULLA_E2E_ARTIFACT_DIR || (process.platform === 'win32'
    ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e')))
  const aggregateId = process.env.BULLA_E2E_RUN_ID || `acceptance-${randomUUID()}`
  if (!runPattern.test(aggregateId) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(aggregateId)) {
    throw new RunnerError('invalid-run-id')
  }
  const { port } = validateOrigin(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
  const settings = {
    distName: process.env.BULLA_E2E_DIST_DIR || '.next-bulla-e2e',
    browser: process.env.BULLA_E2E_BROWSER || '',
    serverMode: process.env.BULLA_E2E_SERVER_MODE || 'development',
  }
  if (!['', 'chrome', 'msedge', 'chromium'].includes(settings.browser) || !serverModes.has(settings.serverMode)) {
    throw new RunnerError('unsafe-runtime-option')
  }
  if (settings.serverMode === 'production') assertCompiledPlatform()
  await validateDist(settings.distName, artifactRoot)
  const options = parseArguments(process.argv.slice(2), await discoverSpecs())
  const root = path.join(artifactRoot, aggregateId)
  const runs = planRuns(options.specs, root, port)
  for (const run of runs) run.serverMode = settings.serverMode
  await freshDirectory(artifactRoot, true)
  await freshDirectory(root) // Refuse an existing ID; never reset or overwrite it.
  await freshDirectory(path.join(root, 'specs'))
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    await checkpoint(root, aggregateId, runs)
    await runSequential(runs, async run => {
      console.log(`Bulla browser: ${run.spec} (${run.id}, ${run.origin})`)
      const result = await executeSpec(run, options, settings, abort.signal)
      console.log(`Bulla browser: ${run.spec}: ${result.status} (${result.reason})`)
      return result
    }, () => checkpoint(root, aggregateId, runs), abort.signal)
    const passed = runs.filter(run => run.status === 'passed').length
    console.log(`Bulla browser aggregate ${aggregateId}: ${passed}/${runs.length} specs passed. See REPORT.md/results.json under the configured artifact directory.`)
    if (abort.signal.aborted) process.exitCode = 130
    else if (passed !== runs.length) process.exitCode = 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

// Importing the pure helpers in safety tests must never spawn or write anything.
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  await main().catch(error => {
    console.error(`Bulla browser acceptance refused/failed: ${error instanceof RunnerError ? error.reason : 'runner-error'}. Raw error details are not printed.`)
    process.exitCode = 1
  })
}
