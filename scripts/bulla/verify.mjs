/**
 * Repeatable local recovery checks with a Markdown report after every step.
 * No installs, remote migrations, deployment, scheduling or destructive cleanup.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const flags = new Set(process.argv.slice(2))
if ([...flags].some(flag => !['--build', '--e2e'].includes(flag))) {
  throw new Error('Supported options: --build, --e2e')
}
const taskRoot = process.env.BULLA_TASK_DIR || (process.platform === 'win32'
  ? 'D:/All tasks + Automations/Bulla-Recovery'
  : path.join(os.tmpdir(), 'bulla-recovery'))
if (!path.isAbsolute(taskRoot) || path.resolve(taskRoot) === path.parse(path.resolve(taskRoot)).root) {
  throw new Error('BULLA_TASK_DIR must name an absolute, dedicated task directory, not a drive root.')
}
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const runRoot = path.join(taskRoot, 'verification', runId)
const reportPath = path.join(runRoot, 'REPORT.md')
const buildRoot = path.join(taskRoot, 'build')
const distName = '.next-bulla-verify'
const buildPath = path.join(buildRoot, 'verify-next')
const buildCanary = `bulla-server-only-canary-${randomUUID()}`

async function ensureLink(linkPath, targetPath) {
  try {
    const entry = await fs.lstat(linkPath)
    if (!entry.isSymbolicLink() ||
        path.relative(await fs.realpath(linkPath), await fs.realpath(targetPath))) {
      throw new Error(`Refusing to replace an existing build/dependency path: ${linkPath}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

await fs.mkdir(runRoot, { recursive: true })
await fs.mkdir(buildPath, { recursive: true })
await ensureLink(path.join(buildRoot, 'node_modules'), path.join(projectRoot, 'node_modules'))
await ensureLink(path.join(projectRoot, distName), buildPath)
const childEnv = {
  ...process.env,
  NEXT_PUBLIC_DATA_MODE: 'local',
  NEXT_PUBLIC_SUPABASE_URL: '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3301',
  LOCAL_DATA_PATH: path.join(runRoot, 'fixture', 'local.json'),
  BULLA_LOCAL_MEDIA_ROOT: path.join(runRoot, 'fixture', 'media'),
  BULLA_TEST_TMP_DIR: path.join(taskRoot, 'test-fixtures'),
  BULLA_TEST_CACHE_DIR: path.join(taskRoot, 'test-cache'),
  BULLA_NEXT_DIST_DIR: distName,
  BULLA_REQUIRE_HTTPS: '0',
  QUAD_REQUIRE_HTTPS: '0',
  BULLA_ALLOW_LOCAL_IN_PRODUCTION: '0',
  QUAD_ALLOW_LOCAL_IN_PRODUCTION: '0',
  BULLA_E2E_ARTIFACT_DIR: path.join(taskRoot, 'e2e'),
  BULLA_E2E_BASE_URL: 'http://127.0.0.1:3301',
  BULLA_E2E_RUN_ID: `verify-${runId}`,
  BULLA_E2E_DIST_DIR: distName,
  // Never accidentally reuse the owner's local data server.
  BULLA_E2E_USE_RUNNING_SERVER: '0',
}
if (!childEnv.BULLA_E2E_BROWSER && process.platform === 'win32') {
  for (const [channel, executable] of [
    ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
    ['msedge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ]) {
    try { await fs.access(executable); childEnv.BULLA_E2E_BROWSER = channel; break } catch { /* Try the next installed browser. */ }
  }
}
const cli = relative => path.join(projectRoot, 'node_modules', relative)
const steps = [
  ['Route types', cli('next/dist/bin/next'), ['typegen']],
  ['Non-incremental TypeScript', cli('typescript/bin/tsc'), ['--noEmit', '--incremental', 'false']],
  ['Lint', cli('eslint/bin/eslint.js'), ['.']],
  ['Unit, action and database tests', cli('vitest/vitest.mjs'), [
    'run', '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json',
    `--outputFile.json=${path.join(runRoot, 'tests.json')}`,
  ]],
  ...(flags.has('--build') ? [['Production compilation (not a launch approval)', cli('next/dist/bin/next'), ['build']]] : []),
  ...(flags.has('--build') ? [['Deployment artifact privacy', path.join(projectRoot, 'scripts/bulla/check-build.mjs'), [
    path.join(projectRoot, distName), path.join(runRoot, 'build-privacy.md'),
  ]]] : []),
  ...(flags.has('--e2e') ? [['Isolated local browser acceptance', path.join(projectRoot, 'scripts/bulla/browser-acceptance.mjs'), []]] : []),
].map(([name, executable, args]) => ({ name, executable, args, status: 'Pending', seconds: null }))

async function checkpoint() {
  const lines = [
    '# Bulla — local verification report', '',
    `Run: ${runId}`, '',
    `Source: \`${projectRoot}\``, '',
    '| Check | Result | Seconds |', '| --- | --- | --- |',
    ...steps.map(step => `| ${step.name} | ${step.status} | ${step.seconds ?? '—'} |`),
    '', '## Evidence and remaining work', '',
    '- Detailed automated results, when produced, are in `tests.json` beside this report.',
    '- Build privacy evidence, when requested, is in `build-privacy.md`; the nonempty fake server-key value is never recorded.',
    `- Browser artifacts, if requested, are in \`${path.join(taskRoot, 'e2e', childEnv.BULLA_E2E_RUN_ID)}\`.`,
    '- This run uses synthetic local data. It does not verify hosted Auth, REST/RLS, Realtime, storage, backups or capacity.',
    '- No claim of a complete redesign, public launch readiness or 50,000-user capacity follows from a passing check.',
    `- Read \`${path.join(projectRoot, 'docs/bulla/STATUS.md')}\` and \`${path.join(projectRoot, 'docs/bulla/ISSUES.md')}\` before continuing.`,
    '- Next: resolve the first failed check; if all checks pass, advance the next unchecked acceptance criterion and update the canonical status/checkpoint.',
    '- Run only one verifier at a time; generated build output is intentionally retained on the task drive.',
    '',
  ]
  await fs.writeFile(reportPath, lines.join('\n'))
}

await checkpoint()
console.log(`Bulla verification report: ${reportPath}`)
for (const step of steps) {
  const started = Date.now()
  step.status = 'Running'
  await checkpoint()
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, [step.executable, ...step.args], {
      cwd: projectRoot,
      env: {
        ...childEnv,
        ...(step.args[0] === 'build' ? { SUPABASE_SERVICE_ROLE_KEY: buildCanary } : {}),
        ...(step.name === 'Deployment artifact privacy' ? { BULLA_BUILD_SECRET_CANARY: buildCanary } : {}),
      },
      stdio: 'inherit', windowsHide: true,
    })
    child.once('error', () => resolve(1))
    child.once('exit', code => resolve(code ?? 1))
  })
  step.seconds = Math.round((Date.now() - started) / 1000)
  step.status = exitCode === 0 ? 'Passed' : 'Failed'
  await checkpoint()
  if (exitCode !== 0) {
    for (const pending of steps.filter(candidate => candidate.status === 'Pending')) pending.status = 'Not run'
    await checkpoint()
    process.exitCode = exitCode
    break
  }
}
