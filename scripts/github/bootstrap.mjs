#!/usr/bin/env node
/**
 * Bootstrap the GitHub side of this project from docs/plan/issues.json.
 *
 *   node scripts/github/bootstrap.mjs --dry-run     # print the plan, change nothing
 *   node scripts/github/bootstrap.mjs               # labels, milestones, issues
 *   node scripts/github/bootstrap.mjs --project     # ...and create the board
 *   node scripts/github/bootstrap.mjs --skip-repo   # repo already exists
 *
 * Why a script rather than a checklist in a document: the manifest is the source of
 * truth for what is planned, and a plan that has to be retyped into a web form is a
 * plan that drifts from the repository within a week. Re-running this is safe — every
 * step checks first, so it creates what is missing and leaves the rest alone.
 *
 * Requires `gh` authenticated with at least `repo` scope. Creating a Project needs
 * `project` as well: run `gh auth refresh -s project` first, or skip --project.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const MANIFEST = join(ROOT, 'docs', 'plan', 'issues.json')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const DRY = flag('--dry-run')
const WITH_PROJECT = flag('--project')
const SKIP_REPO = flag('--skip-repo')

// Target week for each milestone, from docs/plan/GITHUB.md §3. Due dates are derived
// from the run date rather than hard-coded, so re-running re-dates instead of lying.
const TARGET_WEEKS = { M0: 1, M1: 3, M2: 6, M3: 9, M4: 13, M5: 16, M6: 20, M7: 24, M8: 27 }

const ok = (m) => console.log(`  \u2713 ${m}`)
const skip = (m) => console.log(`  \u00b7 ${m} (already there)`)
const would = (m) => console.log(`  \u2192 ${m}`)
const fail = (m) => console.error(`  \u2717 ${m}`)

// ---------------------------------------------------------------- gh plumbing

function ghBin() {
  // Probed without a shell: passing args through `shell: true` on Windows is
  // deprecated for good reason, and a plain command name resolves to the .exe
  // on PATH anyway.
  const candidates = [
    process.env.GH_BIN,
    'gh',
    'C:/Users/Bullza/tools/gh/bin/gh.exe',
    '/usr/bin/gh',
    '/usr/local/bin/gh',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  throw new Error('gh CLI not found. Install it or set GH_BIN to its full path.')
}

const GH = ghBin()

/** Run gh and return stdout. Throws with gh's stderr on failure. */
function gh(args, { input, allowFail = false } = {}) {
  const res = spawnSync(GH, args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 })
  if (res.status !== 0 && !allowFail) {
    const detail = (res.stderr || res.stdout || '').trim()
    throw new Error(`gh ${args.join(' ')}\n${detail}`)
  }
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }
}

function ghJson(args, opts) {
  const { out } = gh(args, opts)
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

/** gh api returns whatever the endpoint returns — a JSON array here, or an error object. */
function ghArray(args, opts) {
  const parsed = ghJson(args, opts)
  return Array.isArray(parsed) ? parsed : []
}

/** Issue bodies and multi-line arguments go through stdin, never the command line. */
function ghWithStdin(args, body) {
  return gh(args, { input: body })
}

// ---------------------------------------------------------------- manifest

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const { repo: repoSpec, labels, milestones, issues } = manifest

// ---------------------------------------------------------------- preflight

console.log('\n  Quad — GitHub bootstrap')
console.log(`  manifest:  ${MANIFEST}`)
console.log(`  mode:      ${DRY ? 'dry run (nothing will be created)' : 'create'}\n`)

const auth = gh(['auth', 'status'], { allowFail: true })
if (!auth.ok && !auth.out && !auth.err) throw new Error('gh is not authenticated. Run: gh auth login')
// `gh auth status` writes to stderr on some versions and stdout on others; read both.
const authText = `${auth.out}\n${auth.err}`
const scopeLine = /Token scopes:\s*(.+)/.exec(authText)?.[1] ?? ''
const scopes = [...scopeLine.matchAll(/'([^']+)'/g)].map((m) => m[1])
// --jq prints a bare string, not JSON, so this one does not go through ghJson.
const login = gh(['api', 'user', '--jq', '.login'], { allowFail: true }).out || ''
console.log(`  account:   ${login}`)
console.log(`  scopes:    ${scopes || 'unknown'}\n`)

const owner = process.env.GH_OWNER || login
const fullName = `${owner}/${repoSpec.name}`

// ---------------------------------------------------------------- 1. repository

if (SKIP_REPO) {
  skip('repository step skipped (--skip-repo)')
} else {
  const existing = ghJson(['repo', 'view', fullName, '--json', 'name'], { allowFail: true })
  if (existing?.name) {
    skip(`repository ${fullName} exists`)
  } else if (DRY) {
    would(`create ${repoSpec.visibility} repository ${fullName}`)
  } else {
    gh([
      'repo', 'create', repoSpec.name,
      `--${repoSpec.visibility}`,
      '--source', ROOT,
      '--remote', 'origin',
      '--description', repoSpec.description,
    ])
    ok(`created ${repoSpec.visibility} repository ${fullName}`)
  }

  if (DRY) {
    would(`set description, topics (${repoSpec.topics.length}) and homepage`)
  } else {
    gh(['repo', 'edit', fullName, '--description', repoSpec.description, '--add-topic', repoSpec.topics.join(',')])
    ok('description and topics set')
  }
}

// ---------------------------------------------------------------- 2. labels

console.log('\n  Labels')
for (const label of labels) {
  if (DRY) {
    would(`label ${label.name}`)
    continue
  }
  gh(['label', 'create', label.name, '--color', label.color, '--description', label.description, '--force'])
  ok(`label ${label.name}`)
}

// ---------------------------------------------------------------- 3. milestones

console.log('\n  Milestones')
const existingMilestones = new Map(
  ghArray(['api', `repos/${fullName}/milestones?state=all&per_page=100`], { allowFail: true }).map((m) => [
    m.title,
    m.number,
  ]),
)

const today = new Date()
const milestoneNumbers = new Map()

for (const milestone of milestones) {
  const code = milestone.title.slice(0, 2)
  const weeks = TARGET_WEEKS[code]
  const due = new Date(today.getTime() + weeks * 7 * 24 * 3600 * 1000)
  due.setUTCHours(23, 59, 0, 0)

  if (existingMilestones.has(milestone.title)) {
    milestoneNumbers.set(milestone.title, existingMilestones.get(milestone.title))
    skip(`milestone ${milestone.title}`)
    continue
  }
  if (DRY) {
    would(`milestone ${milestone.title} (due ${due.toISOString().slice(0, 10)}, week ${weeks})`)
    continue
  }
  const created = ghJson([
    'api', `repos/${fullName}/milestones`,
    '-f', `title=${milestone.title}`,
    '-f', `description=${milestone.description}`,
    '-f', `due_on=${due.toISOString()}`,
  ])
  milestoneNumbers.set(milestone.title, created.number)
  ok(`milestone ${milestone.title} → #${created.number}`)
}

// ---------------------------------------------------------------- 4. issues

console.log('\n  Issues')
const existingIssues = new Set(
  ghArray(['issue', 'list', '--state', 'all', '--limit', '500', '--json', 'title'], { allowFail: true }).map(
    (i) => i.title,
  ),
)

let created = 0
const createdUrls = []

for (const issue of issues) {
  if (existingIssues.has(issue.title)) {
    skip(`#${issue.title}`)
    continue
  }
  if (DRY) {
    would(`[${issue.size}] ${issue.milestone.slice(0, 2)} ${issue.title}`)
    continue
  }

  const args = [
    'issue', 'create',
    '--title', issue.title,
    '--body-file', '-',
    '--label', issue.labels.join(','),
  ]
  const ms = milestoneNumbers.get(issue.milestone)
  if (ms) args.push('--milestone', issue.milestone)

  try {
    const { out } = ghWithStdin(args, issue.body)
    createdUrls.push(out)
    created += 1
    ok(`#${issue.title}`)
  } catch (error) {
    fail(`could not create "${issue.title}": ${error.message}`)
  }
}

if (DRY) would(`${issues.length} issues total (${issues.filter((i) => i.size === 'S').length} S, ${issues.filter((i) => i.size === 'M').length} M, ${issues.filter((i) => i.size === 'L').length} L)`)

// ---------------------------------------------------------------- 5. board

if (WITH_PROJECT) {
  console.log('\n  Project board')
  if (!scopes.includes('project')) {
    fail('the token has no `project` scope — run: gh auth refresh -s project, then re-run with --project')
  } else if (DRY) {
    would('create Project "Quad" and add every issue to it')
  } else {
    const project = ghJson(['project', 'create', '--owner', owner, '--title', 'Quad', '--format', 'json'], {
      allowFail: true,
    })
    if (!project?.number) {
      fail('could not create the project (see gh output above)')
    } else {
      ok(`project Quad #${project.number}`)
      let added = 0
      for (const url of createdUrls) {
        const res = gh(['project', 'item-add', String(project.number), '--owner', owner, '--url', url], {
          allowFail: true,
        })
        if (res.ok) added += 1
      }
      ok(`${added} issues added to the board`)
      console.log(`\n  Board: ${project.url ?? `https://github.com/users/${owner}/projects/${project.number}`}`)
    }
  }
} else {
  console.log('\n  Project board: skipped (pass --project to create it)')
}

// ---------------------------------------------------------------- done

console.log(
  DRY
    ? '\n  Dry run complete. Nothing was created. Re-run without --dry-run to apply.\n'
    : `\n  Done. ${created} issue(s) created. Next: open the board, take the top M0 card, and start with\n  the in-flight work commit — docs/plan/PLAN.md §9.\n`,
)
