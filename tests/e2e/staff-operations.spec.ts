import {
  test, expect, type BrowserContext, type Locator, type Page, type Response,
} from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { hasNoStoreCachePolicy } from './helpers/no-store-cache'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { LocalOpportunity, LocalReport, Tables } from '../../src/lib/local/db'

/**
 * AUTHORING-ONLY HANDOFF: main runs this file alone in a fresh per-spec server.
 * One bounded journey: two real student signups/onboardings and logins, plus
 * two NEW staff identities created by the actual local-staff.mjs --apply CLI.
 * Never use --reset/--grant-existing, owner port 3000, shared data or cloud.
 *
 * Store reads are evidence only. No cookie injection, action/role mocks,
 * synthetic report insertion, native DB connection or application import runs.
 * Negative HTTP probes replay genuine UI action bytes with the probing account's
 * OWN real login session; they do not forward the original caller's cookies.
 * Private operator credentials/backups remain inside this run, never attached.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const sessionName = 'quad_local_session'
const maxFixtureBytes = 5 * 1024 * 1024
const maxActionBytes = 64 * 1024
const maxResponseBytes = 512 * 1024
type Account = {
  userId: string
  profileId: string
  handle: string
  displayName: string
  email: string
  password: string
  role: 'admin' | 'moderator' | null
}
type Listing = { row: LocalOpportunity; route: string; description: string }
type FiledReport = { row: LocalReport; detail: string }
type ActionWire = { url: string; headers: Record<string, string>; body: Buffer }
type OperatorResult = {
  status: string
  role: string
  email: string
  userId: string
  store: string
  credentialFile: string
  backupFile: string
}

let origin: string
let repositoryRoot: string
let runRoot: string
let fixtureRoot: string
let fixtureFile: string
const knownUsers = new Set<string>()
const privateCanaries = new Set<string>()

// Password fills and action bytes must not become shareable traces/video.
// Main's raw process/reporter logs and the operator's files still stay private.
test.use({
  storageState: { cookies: [], origins: [] },
  serviceWorkers: 'block',
  trace: 'off',
  screenshot: 'off',
  video: 'off',
})

function samePath(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Staff acceptance must stay inside its dedicated isolated artifact directory.')
  }
}

async function plainDirectory(target: string) {
  // Check every existing ancestor, not just the last entry of a junction path.
  const directories: string[] = []
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    directories.unshift(current)
    if (current === path.dirname(current)) break
  }
  for (const directory of directories) {
    const entry = await fs.lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(directory, await fs.realpath(directory))) {
      throw new Error('Refusing a replaced, symlinked or non-directory staff fixture path.')
    }
  }
}

function freshOrigin(baseURL: string | undefined) {
  if (!baseURL) throw new Error('A dedicated loopback baseURL is required.')
  const url = new URL(baseURL)
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port || port < 1024 || port === 3000 || process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Use a fresh loopback webServer on a dedicated port, never port 3000 or a reused server.')
  }
  return url.origin
}

async function readFixture(): Promise<Partial<Tables>> {
  assertInside(fixtureRoot, fixtureFile)
  await plainDirectory(fixtureRoot)
  const entry = await fs.lstat(fixtureFile)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxFixtureBytes ||
    !samePath(fixtureFile, await fs.realpath(fixtureFile))) {
    throw new Error('Refusing a replaced or oversized staff fixture.')
  }
  const parsed: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some(rows => !Array.isArray(rows))) {
    throw new Error('Expected only array tables in the isolated staff fixture.')
  }
  return parsed as Partial<Tables>
}

async function onlySyntheticSnapshot() {
  const db = await readFixture()
  if ((db.users ?? []).some(user => !knownUsers.has(user.id)) ||
    (db.profiles ?? []).some(profile => !knownUsers.has(profile.user_id)) ||
    (db.user_roles ?? []).some(role => !knownUsers.has(role.user_id))) {
    throw new Error('An unknown account changed this fixture; staff acceptance will not mutate it.')
  }
  return db
}

function protectedState(db: Partial<Tables>) {
  // Budget-ledger housekeeping is not a semantic write. Every account,
  // session, content, report, notification and audit row is still compared.
  return Object.fromEntries(Object.entries(db).filter(([name]) => name !== 'mutation_limit_windows'))
}

async function unchanged(before: ReturnType<typeof protectedState>) {
  expect(isDeepStrictEqual(protectedState(await onlySyntheticSnapshot()), before),
    'A refused or cancelled staff operation changed committed domain/account state').toBe(true)
}

function secretFree(text: string) {
  expect([...privateCanaries].every(secret => !text.includes(secret)),
    'Staff response serialized a synthetic password, password hash or opaque session').toBe(true)
}

// Playwright requires fixture destructuring even when this hook only uses testInfo.
test.beforeAll(async ({}, info) => {
  origin = freshOrigin(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
  repositoryRoot = path.resolve(path.dirname(info.file), '..', '..')
  if (!samePath(await fs.realpath(process.cwd()), await fs.realpath(repositoryRoot))) {
    throw new Error('Run staff acceptance from the active application checkout.')
  }
  const root = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(root) || !run || !/^[a-zA-Z0-9-]{1,128}$/.test(run)) {
    throw new Error('Use a new isolated Playwright run identifier for this spec.')
  }
  runRoot = path.resolve(root, run)
  assertInside(root, runRoot)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)
  const relativeToCheckout = path.relative(repositoryRoot, runRoot)
  if (!relativeToCheckout || (!relativeToCheckout.startsWith(`..${path.sep}`) &&
    relativeToCheckout !== '..' && !path.isAbsolute(relativeToCheckout))) {
    throw new Error('Private staff acceptance artifacts must be outside the source checkout.')
  }
  fixtureRoot = path.join(runRoot, 'fixture')
  fixtureFile = path.join(fixtureRoot, 'local.json')
  const server = info.config.webServer
  const env = server?.env
  if (!server || server.reuseExistingServer !== false || !server.url ||
    new URL(server.url).origin !== origin || env?.NEXT_PUBLIC_DATA_MODE !== 'local' ||
    env.NEXT_PUBLIC_SUPABASE_URL !== '' || env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' ||
    env.SUPABASE_SERVICE_ROLE_KEY !== '' || !env.LOCAL_DATA_PATH ||
    !samePath(env.LOCAL_DATA_PATH, fixtureFile) || !env.BULLA_LOCAL_MEDIA_ROOT ||
    !path.isAbsolute(env.BULLA_LOCAL_MEDIA_ROOT)) {
    throw new Error('The fresh webServer must explicitly isolate data/media paths and clear cloud keys.')
  }
  assertInside(fixtureRoot, env.BULLA_LOCAL_MEDIA_ROOT)
  await plainDirectory(runRoot)
  await plainDirectory(fixtureRoot)
  await plainDirectory(env.BULLA_LOCAL_MEDIA_ROOT)
  await plainDirectory(path.join(runRoot, 'private'))
  if ((await fs.readdir(env.BULLA_LOCAL_MEDIA_ROOT)).length) {
    throw new Error('This spec requires a new empty media fixture; existing files are never reset.')
  }
  let db: Partial<Tables> = {}
  try { db = await readFixture() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Object.values(db).some(rows => rows.length)) {
    throw new Error('This spec requires an empty fixture, not another spec or owner account.')
  }
  const marker = await fs.open(path.join(fixtureRoot, 'staff-operations-fixture.marker'), 'wx', 0o600)
  await marker.close() // Retain after failure. A retry requires a NEW run ID.
})

async function onlyLocalNetwork(context: BrowserContext) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['about:', 'blob:', 'data:'].includes(url.protocol)) {
      await route.continue()
    } else {
      await route.abort('blockedbyclient')
      throw new Error('Staff acceptance attempted a non-fixture network request.')
    }
  })
  await context.routeWebSocket(url => {
    const local = new URL(origin)
    return url.hostname !== local.hostname || url.port !== local.port || url.protocol !== 'ws:'
  }, socket => {
    socket.close({ code: 1008, reason: 'Loopback-only acceptance' })
    throw new Error('Staff acceptance attempted a non-fixture WebSocket.')
  })
}

test.beforeEach(async ({ context, baseURL }, info) => {
  if (freshOrigin(baseURL) !== origin || info.config.workers !== 1 ||
    info.project.retries !== 0 || info.project.repeatEach !== 1 || info.retry !== 0) {
    throw new Error('Run this spec alone with one worker, no retries/repeats and the fresh webServer.')
  }
  assertInside(runRoot, info.outputDir)
  expect((await context.cookies()).some(cookie => cookie.name === sessionName)).toBe(false)
  await onlyLocalNetwork(context)
  info.annotations.push({
    type: 'local-only',
    description: 'Actual isolated local staff/UI/session checks; local MFA is unsupported. Hosted Auth/MFA/PostgREST/audit immutability and recovery are not exercised.',
  })
})

/** Require the exact POST and a bounded domain outcome, never RSC closure. */
async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const response = await completeAction(page, control, outcome)
  expect(new URL(response.url()).origin).toBe(origin)
  expect(response.status()).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

async function sessionProof(page: Page, account: Account) {
  const cookie = (await page.context().cookies()).find(row => row.name === sessionName)
  expect(Boolean(cookie?.httpOnly), 'Actual credential authentication must issue an opaque HttpOnly session').toBe(true)
  if (!cookie) throw new Error('The synthetic credential login did not issue a session.')
  const db = await onlySyntheticSnapshot()
  const digest = createHash('sha256').update(cookie.value).digest('hex')
  expect((db.sessions ?? []).some(row => row.user_id === account.userId &&
    row.token_hash === digest && Date.parse(row.expires_at) > Date.now())).toBe(true)
  const user = (db.users ?? []).find(row => row.id === account.userId)
  expect(user?.email === account.email).toBe(true)
  expect((db.profiles ?? []).some(row => row.id === account.profileId && row.user_id === account.userId)).toBe(true)
  expect((db.user_roles ?? []).filter(row => row.user_id === account.userId).map(row => row.role))
    .toEqual(account.role ? [account.role] : [])
  privateCanaries.add(account.password)
  privateCanaries.add(cookie.value)
  if (user) privateCanaries.add(user.password_hash)
  return digest
}

async function signup(page: Page, handle: string, displayName: string): Promise<Account> {
  const email = `${handle}@example.test`
  const password = `Staff-student-${randomBytes(24).toString('base64url')}-9Aa!`
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(email)
  await page.getByLabel(/^Password/).fill(password)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL(url => url.pathname === '/onboarding'))
  await expect(page).toHaveURL(url => url.pathname === '/onboarding')
  const created = await readFixture()
  const user = (created.users ?? []).find(row => row.email === email)
  const initial = (created.profiles ?? []).find(row => row.user_id === user?.id)
  if (!user || !initial || knownUsers.has(user.id) ||
    (created.users ?? []).filter(row => !knownUsers.has(row.id)).length !== 1) {
    throw new Error('Signup did not create exactly one new synthetic student.')
  }
  knownUsers.add(user.id)
  expect(initial.visibility).toBe('private')
  expect(initial.onboarding_completed).toBe(false)
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await page.getByLabel(/^Choose a username/).fill(handle)
  await page.getByLabel(/^Who can see your profile/).selectOption('public')
  await submit(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL(url => url.pathname === '/me')
    await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  })
  await expect(page).toHaveURL(url => url.pathname === '/me')
  await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  const account = { userId: user.id, profileId: initial.id, handle, displayName, email, password, role: null }
  const db = await onlySyntheticSnapshot()
  expect((db.profiles ?? []).find(row => row.id === initial.id)).toMatchObject({
    username: handle, visibility: 'public', onboarding_completed: true,
  })
  await sessionProof(page, account)
  return account
}

async function logout(page: Page, account: Account) {
  const previous = await sessionProof(page, account)
  await page.getByRole('button', { name: 'Open campus menu', exact: true }).click()
  const menu = page.getByRole('dialog', { name: 'Campus workspace', exact: true })
  await submit(page, menu.getByRole('button', { name: 'Sign out', exact: true }),
    () => expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/'))
  await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/')
  expect((await page.context().cookies()).some(row => row.name === sessionName)).toBe(false)
  expect((await onlySyntheticSnapshot()).sessions?.some(row => row.token_hash === previous)).toBe(false)
}

async function login(page: Page, account: Account) {
  expect((await page.context().cookies()).some(cookie => cookie.name === sessionName)).toBe(false)
  await page.goto('/login')
  await page.getByLabel(/^Email address/).fill(account.email)
  await page.getByLabel(/^Password/).fill(account.password)
  await submit(page, page.getByRole('button', { name: 'Sign in', exact: true }),
    () => expect(page).toHaveURL(url => url.pathname === '/feed'))
  await expect(page).toHaveURL(url => url.pathname === '/feed')
  await sessionProof(page, account)
}

function operatorEnvironment(): NodeJS.ProcessEnv {
  // No NODE_OPTIONS, owner-store overrides, real provider keys or proxy tokens.
  const keys = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  ])
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' }
  for (const [key, value] of Object.entries(process.env)) {
    if (keys.has(key.toUpperCase()) && typeof value === 'string') env[key.toUpperCase()] = value
  }
  return {
    ...env, NODE_OPTIONS: '', NODE_PATH: '', NEXT_PUBLIC_DATA_MODE: 'local',
    LOCAL_DATA_PATH: fixtureFile, NEXT_PUBLIC_SUPABASE_URL: '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_ACCESS_TOKEN: '', DATABASE_URL: '',
  }
}

async function privateFile(directory: string, file: string, maxBytes: number) {
  assertInside(directory, file)
  await plainDirectory(directory)
  const entry = await fs.lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 ||
    entry.size > maxBytes || !samePath(file, await fs.realpath(file))) {
    throw new Error('The isolated operator did not return a bounded plain private file.')
  }
  return fs.readFile(file, 'utf8')
}

async function provisionStaff(role: 'admin' | 'moderator', suffix: string): Promise<Account> {
  const before = await onlySyntheticSnapshot() // A real student signup created the store.
  const handle = `staff_${role === 'admin' ? 'a' : 'm'}_${suffix}`
  const email = `${handle}@example.test`
  const displayName = `Synthetic ${role} ${suffix}`
  const credentialsDirectory = path.join(runRoot, 'private', `staff-${role}`)
  const operatorDirectory = path.join(runRoot, 'private', `operator-${role}`)
  assertInside(runRoot, credentialsDirectory)
  assertInside(runRoot, operatorDirectory)
  await plainDirectory(path.dirname(credentialsDirectory))
  await fs.mkdir(credentialsDirectory, { mode: 0o700 }) // Existing directory is a refusal, never a reset.
  await plainDirectory(credentialsDirectory)
  // The operator reads cwd/.env.local. A fresh sibling working directory keeps
  // it from even reading the checkout's owner configuration/credentials.
  await fs.mkdir(operatorDirectory, { mode: 0o700 })
  await plainDirectory(operatorDirectory)
  const operator = path.join(repositoryRoot, 'scripts', 'bulla', 'local-staff.mjs')
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [
      operator, '--apply', '--role', role, '--email', email, '--username', handle,
      '--display-name', displayName, '--store', fixtureFile,
      '--credentials-dir', credentialsDirectory,
    ], {
      cwd: operatorDirectory, env: operatorEnvironment(), encoding: 'utf8',
      shell: false, windowsHide: true, timeout: 30_000, maxBuffer: maxActionBytes,
    }, (error, stdout, stderr) => {
      if (error || stderr.trim()) {
        // Never expose execFile errors: they contain command args/stdio.
        reject(new Error('Synthetic staff operator failed; private output was not printed and no automatic retry/reset was attempted.'))
      } else resolve(stdout)
    })
  })
  let value: unknown
  try { value = JSON.parse(raw) } catch {
    throw new Error('The synthetic staff operator did not return its expected private summary.')
  }
  const result = value as Partial<OperatorResult> | null
  if (!result || result.status !== 'created' || result.role !== role || result.email !== email ||
    typeof result.userId !== 'string' || knownUsers.has(result.userId) ||
    typeof result.store !== 'string' || !samePath(result.store, fixtureFile) ||
    typeof result.credentialFile !== 'string' || typeof result.backupFile !== 'string') {
    throw new Error('Only a newly created isolated staff identity is accepted; unchanged/promoted/rotated accounts are refused.')
  }
  const credentials = await privateFile(credentialsDirectory, result.credentialFile, 8192)
  const password = credentials.match(/^Password: ([^\r\n]+)$/m)?.[1]
  if (credentials.match(/^Email: ([^\r\n]+)$/m)?.[1] !== email ||
    credentials.match(/^Role: ([^\r\n]+)$/m)?.[1] !== role || !password ||
    !/^[A-Za-z0-9]{28}$/.test(password)) {
    throw new Error('The operator credential file did not match this new synthetic identity.')
  }
  const backup = await privateFile(credentialsDirectory, result.backupFile, maxFixtureBytes)
  expect(isDeepStrictEqual(JSON.parse(backup), before), 'Operator backup must contain only the exact prior synthetic snapshot').toBe(true)
  const after = await readFixture()
  const profile = (after.profiles ?? []).find(row => row.user_id === result.userId)
  const user = (after.users ?? []).find(row => row.id === result.userId)
  if (!profile || !user || user.email !== email || profile.username !== handle ||
    profile.display_name !== displayName || profile.visibility !== 'private' ||
    profile.onboarding_completed !== true) {
    throw new Error('The operator did not create the expected new private local staff profile.')
  }
  const previousRows = {
    ...after,
    users: (after.users ?? []).filter(row => row.id !== user.id),
    profiles: (after.profiles ?? []).filter(row => row.user_id !== user.id),
    user_roles: (after.user_roles ?? []).filter(row => row.user_id !== user.id),
  }
  expect(isDeepStrictEqual(previousRows, before), 'Provisioning must preserve every pre-existing synthetic row').toBe(true)
  expect((after.user_roles ?? []).filter(row => row.user_id === user.id).map(row => row.role)).toEqual([role])
  knownUsers.add(user.id)
  privateCanaries.add(password)
  privateCanaries.add(user.password_hash)
  return { userId: user.id, profileId: profile.id, handle, displayName, email, password, role }
}

async function localMfaLimitation(page: Page, account: Account) {
  await sessionProof(page, account)
  const before = protectedState(await onlySyntheticSnapshot())
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Account security', exact: true })).toBeVisible()
  const limitation = page.getByRole('status').filter({
    hasText: 'Local accounts have no multi-factor authentication, provider recovery or AAL2 assurance.',
  })
  await expect(limitation).toBeVisible()
  await expect(limitation).toContainText('Local staff tools are only a private, loopback-bound preview')
  await expect(page.getByRole('button', { name: 'Create setup QR', exact: true })).toHaveCount(0)
  await expect(page.getByLabel(/^Authenticator code/)).toHaveCount(0)
  await unchanged(before)
}

async function publishSyntheticStaff(page: Page, account: Account) {
  await page.goto('/me/edit')
  await expect(page.getByRole('combobox', { name: 'Profile visibility', exact: true })).toHaveValue('private')
  await page.getByRole('combobox', { name: 'Profile visibility', exact: true }).selectOption('public')
  await submit(page, page.getByRole('button', { name: 'Save changes', exact: true }),
    () => expect(page.getByText('Saved.', { exact: true })).toBeVisible())
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  expect((await onlySyntheticSnapshot()).profiles?.find(row => row.id === account.profileId)?.visibility).toBe('public')
  await sessionProof(page, account)
}

async function createListing(page: Page, account: Account, label: string): Promise<Listing> {
  await sessionProof(page, account)
  const title = `Synthetic staff acceptance ${label} ${account.handle}`
  const description = `Only synthetic local acceptance content for ${label}; no real employer, application or personal data.`
  await page.goto('/opportunities/new')
  await page.getByLabel(/^Title/).fill(title)
  await page.getByLabel(/^Organisation/).fill('Synthetic acceptance organisation')
  await page.getByLabel(/^Description/).fill(description)
  await page.getByRole('combobox', { name: /^Where/ }).selectOption('remote')
  await page.getByLabel('Or an email address', { exact: true }).fill(`synthetic_contact_${randomBytes(6).toString('hex')}@example.test`)
  await page.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('public')
  await submit(page, page.getByRole('button', { name: 'Post the listing', exact: true }), async () => {
    await expect(page).toHaveURL(url => /^\/opportunities\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('/new'))
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  })
  await expect(page).toHaveURL(url => /^\/opportunities\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('/new'))
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  const rows = (await onlySyntheticSnapshot()).opportunities?.filter(row =>
    row.posted_by === account.profileId && row.title === title) ?? []
  expect(rows).toHaveLength(1)
  expect(rows[0]?.visibility).toBe('public')
  expect(rows[0]?.description).toBe(description)
  const route = new URL(page.url()).pathname
  return { row: rows[0]!, route, description }
}

async function reportListing(page: Page, reporter: Account, listing: Listing, label: string): Promise<FiledReport> {
  await sessionProof(page, reporter)
  const detail = `Private synthetic report detail ${label} ${randomBytes(8).toString('hex')}`
  await page.goto(listing.route)
  await expect(page.getByRole('heading', { level: 1, name: listing.row.title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Report opportunity', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Report this opportunity', exact: true })
  await dialog.getByRole('radio', { name: 'Something else', exact: true }).check()
  await dialog.getByLabel('Anything else a moderator should know?', { exact: true }).fill(detail)
  await submit(page, dialog.getByRole('button', { name: 'Send report', exact: true }), async () => {
    await expect(dialog.getByText('Report received', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('status')).toContainText('Thank you. A moderator will review it.')
  })
  await expect(dialog.getByText('Report received', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('status')).toContainText('Thank you. A moderator will review it.')
  const rows = (await onlySyntheticSnapshot()).reports?.filter(row =>
    row.opportunity_id === listing.row.id && row.reporter_id === reporter.profileId) ?? []
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: 'open', reason: 'Something else', detail })
  await dialog.getByLabel('Close', { exact: true }).click()
  await expect(dialog).toBeHidden()
  return { row: rows[0]!, detail }
}

function queueRow(page: Page, report: FiledReport) {
  return page.locator('li').filter({ has: page.getByText(report.detail, { exact: true }) })
}

async function captureWire(response: Response, targetId: string): Promise<ActionWire> {
  const request = response.request()
  const url = new URL(request.url())
  const all = await request.allHeaders()
  const body = request.postDataBuffer()
  if (request.method() !== 'POST' || url.origin !== origin || url.search ||
    !['/admin', '/admin/bug-reports'].includes(url.pathname) ||
    !all['next-action'] || !all['content-type'] || !body ||
    body.length > maxActionBytes || !body.includes(Buffer.from(targetId))) {
    throw new Error('The real staff UI did not produce a bounded identifiable Server Action request.')
  }
  const headers: Record<string, string> = { origin, referer: request.url() }
  for (const name of ['next-action', 'content-type', 'next-router-state-tree', 'next-url', 'accept']) {
    if (all[name]) headers[name] = all[name]
  }
  // No cookie, authorization, claimed actor or service-role header is copied.
  return { url: request.url(), headers, body }
}

async function refusedReplay(page: Page, account: Account, wire: ActionWire, refusal: string, hidden: string[]) {
  await sessionProof(page, account)
  const before = protectedState(await onlySyntheticSnapshot())
  // BrowserContext.request automatically uses this account's real login cookies.
  const response = await page.context().request.post(wire.url, {
    headers: wire.headers, data: wire.body, maxRedirects: 0, timeout: 60_000,
  })
  expect(response.status(), 'The actual action must return its refusal, not only a route/protocol error').toBe(200)
  expect(response.headers()['content-type']).toContain('text/x-component')
  // The installed Next.js action handler overrides Proxy's Cache-Control.
  // no-store prevents every cache; private is redundant, not an access guard.
  expect(hasNoStoreCachePolicy(response.headers()['cache-control'])).toBe(true)
  const text = await response.text()
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxResponseBytes)
  expect(text.includes(refusal), 'The real action did not refuse this caller/request').toBe(true)
  expect(text.includes('"status":"success"')).toBe(false)
  for (const value of hidden) expect(text.includes(value), 'Refused action serialized another account’s private staff data').toBe(false)
  secretFree(text)
  await unchanged(before)
  await sessionProof(page, account)
}

async function refusedPage(page: Page, route: string, moderator: boolean, hidden: string[]) {
  const before = protectedState(await onlySyntheticSnapshot())
  const response = await page.goto(route)
  expect(response).not.toBeNull()
  expect(response!.status()).toBe(200) // Refusal is a server-rendered sentence, not a fake 403 claim.
  await expect(page).toHaveURL(url => url.pathname === new URL(route, origin).pathname)
  if (moderator) {
    await expect(page.getByRole('alert')).toContainText('Your account cannot read this')
    await expect(page.getByRole('heading', { level: 2, name: 'Bug reports', exact: true })).toBeVisible()
  } else {
    await expect(page.getByRole('heading', { level: 1, name: 'Not available to your account', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Moderation', exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  const html = await response!.text()
  for (const value of hidden) {
    expect(html.includes(value), 'Direct URL refusal serialized private queue/audit/bug content').toBe(false)
    await expect(page.getByText(value, { exact: true })).toHaveCount(0)
  }
  secretFree(html)
  await unchanged(before)
}

test('real local staff report decisions, caller guards, audit durability and admin-only bug privacy', async ({ page, browser }, info) => {
  test.setTimeout(600_000)
  const contexts: BrowserContext[] = []
  let pageErrors = 0
  page.on('pageerror', () => { pageErrors += 1 })
  async function device() {
    const context = await browser.newContext({
      baseURL: origin, serviceWorkers: 'block', storageState: { cookies: [], origins: [] },
    })
    contexts.push(context)
    await onlyLocalNetwork(context)
    const devicePage = await context.newPage()
    devicePage.on('pageerror', () => { pageErrors += 1 })
    return devicePage
  }
  try {
    const suffix = randomBytes(6).toString('hex')
    const reporterPage = page
    const studentPage = await device()
    const moderatorPage = await device()
    const adminPage = await device()
    const reporter = await signup(reporterPage, `staff_r_${suffix}`, `Synthetic reporter ${suffix}`)
    const student = await signup(studentPage, `staff_s_${suffix}`, `Synthetic student ${suffix}`)
    const moderator = await provisionStaff('moderator', suffix)
    const admin = await provisionStaff('admin', suffix)

    await test.step('each role authenticates with actual credentials; local MFA remains explicitly unsupported', async () => {
      for (const [studentDevice, account] of [[reporterPage, reporter], [studentPage, student]] as const) {
        await logout(studentDevice, account)
        await login(studentDevice, account)
      }
      await login(moderatorPage, moderator)
      await login(adminPage, admin)
      for (const [staffDevice, account] of [[moderatorPage, moderator], [adminPage, admin]] as const) {
        await localMfaLimitation(staffDevice, account)
        await staffDevice.goto('/admin')
        await expect(staffDevice.getByRole('heading', { level: 1, name: 'Moderation', exact: true })).toBeVisible()
        const nav = staffDevice.getByRole('navigation', { name: 'Moderation', exact: true })
        await expect(nav.getByRole('link', { name: /^Bug reports/ })).toHaveCount(account.role === 'admin' ? 1 : 0)
        await expect(nav.getByRole('link', { name: 'All data', exact: true })).toHaveCount(account.role === 'admin' ? 1 : 0)
        await publishSyntheticStaff(staffDevice, account)
      }
      await localMfaLimitation(studentPage, student)
    })

    // Current source offers public report controls on opportunities/events,
    // not posts/profiles. Exercise the mounted real control, without seeding.
    const studentListing = await createListing(studentPage, student, 'student-target')
    const moderatorListing = await createListing(moderatorPage, moderator, 'moderator-target')
    const adminListing = await createListing(adminPage, admin, 'administrator-target')
    const studentReport = await reportListing(reporterPage, reporter, studentListing, 'student')
    const selfReport = await reportListing(reporterPage, reporter, moderatorListing, 'moderator')
    const adminReport = await reportListing(reporterPage, reporter, adminListing, 'administrator')
    expect((await onlySyntheticSnapshot()).reports).toHaveLength(3)

    let selfWire: ActionWire | undefined
    await test.step('moderator self-target and administrator-target decisions refuse without committing evidence or account changes', async () => {
      await moderatorPage.goto('/admin')
      for (const report of [selfReport, adminReport]) {
        const row = queueRow(moderatorPage, report)
        await expect(row).toBeVisible()
        const before = protectedState(await onlySyntheticSnapshot())
        await row.getByRole('button', { name: 'Dismiss', exact: true }).click()
        const dialog = moderatorPage.getByRole('dialog', { name: 'Dismiss this report?', exact: true })
        await dialog.getByLabel(/^Reason/).fill('Synthetic caller guard: another authorised staff member must review this target.')
        const response = await submit(moderatorPage, dialog.getByRole('button', { name: 'Dismiss report', exact: true }),
          () => expect(dialog.getByRole('alert')).toHaveText('You cannot decide this report.'))
        await expect(dialog.getByRole('alert')).toHaveText('You cannot decide this report.')
        await expect(dialog.getByText('Recorded', { exact: true })).toHaveCount(0)
        await unchanged(before)
        if (report === selfReport) selfWire = await captureWire(response, report.row.id)
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        await moderatorPage.reload()
        await expect(queueRow(moderatorPage, report)).toBeVisible()
      }
    })
    if (!selfWire) throw new Error('The real moderator refusal did not provide the caller-guard probe.')
    await test.step('ordinary real login cannot replay a staff action against an open report it does not own', async () => {
      // This caller is neither the reported moderator nor an administrator.
      // Without the role check, the still-open dismissal would be eligible.
      await refusedReplay(studentPage, student, selfWire!, 'That decision is not available.',
        [studentReport.detail, selfReport.detail, adminReport.detail])
    })

    const decisionReason = `Private synthetic decision reason ${randomBytes(8).toString('hex')}`
    let acceptedWire: ActionWire | undefined
    await test.step('moderator confirms one real report decision; durable rows and notifications survive reload', async () => {
      await moderatorPage.goto('/admin')
      const row = queueRow(moderatorPage, studentReport)
      await expect(row).toContainText(studentListing.row.title)
      await expect(row.getByRole('link', { name: reporter.displayName, exact: true })).toBeVisible()
      const before = protectedState(await onlySyntheticSnapshot())
      await row.getByRole('button', { name: 'Hide', exact: true }).click()
      const dialog = moderatorPage.getByRole('dialog', { name: 'Hide this opportunity?', exact: true })
      await expect(dialog.getByLabel(/^Reason/)).toHaveAttribute('required', '')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await unchanged(before)
      await expect(row.getByRole('button', { name: 'Hide', exact: true })).toBeFocused()
      await row.getByRole('button', { name: 'Hide', exact: true }).click()
      await dialog.getByLabel(/^Reason/).fill(decisionReason)
      const response = await submit(moderatorPage, dialog.getByRole('button', { name: 'Hide', exact: true }), async () => {
        await expect.poll(async () => (await onlySyntheticSnapshot()).reports?.find(row => row.id === studentReport.row.id)?.status).toBe('actioned')
        await expect(queueRow(moderatorPage, studentReport)).toHaveCount(0)
      })
      acceptedWire = await captureWire(response, studentReport.row.id)
      await expect.poll(async () => (await onlySyntheticSnapshot()).reports?.find(row => row.id === studentReport.row.id)?.status).toBe('actioned')
      await moderatorPage.goto('/admin')
      await expect(queueRow(moderatorPage, studentReport)).toHaveCount(0)
      await expect(queueRow(moderatorPage, selfReport)).toBeVisible()
      await expect(queueRow(moderatorPage, adminReport)).toBeVisible()
      const db = await onlySyntheticSnapshot()
      const audit = db.moderation_actions ?? []
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        actor_id: moderator.profileId, report_id: studentReport.row.id, action: 'hide_content',
        reason: decisionReason, target_profile_id: student.profileId, target_id: studentListing.row.id,
      })
      expect(Number.isFinite(Date.parse(audit[0]!.created_at))).toBe(true)
      expect(db.content_moderation?.filter(row => row.target_id === studentListing.row.id))
        .toMatchObject([{ kind: 'opportunity', status: 'hidden' }])
      const notifications = db.notifications?.filter(row => row.type === 'moderation_decision') ?? []
      expect(notifications).toHaveLength(2)
      expect(notifications.map(row => row.recipient_id).sort()).toEqual([reporter.profileId, student.profileId].sort())
      expect(notifications.every(row => row.actor_id === null && row.body !== null &&
        !row.body.includes(decisionReason) && !row.body.includes(studentReport.detail))).toBe(true)
    })
    if (!acceptedWire) throw new Error('The real recorded decision did not provide its bounded retry probe.')
    await test.step('a genuine repeated closed-report action does not duplicate or edit the durable audit', async () => {
      await refusedReplay(moderatorPage, moderator, acceptedWire!, 'That decision is not available.', [])
      expect((await onlySyntheticSnapshot()).moderation_actions).toHaveLength(1)
    })

    await test.step('both staff roles read the recorded audit, with no editable record or hidden target body', async () => {
      for (const staffDevice of [moderatorPage, adminPage]) {
        await staffDevice.goto('/admin/audit')
        await expect(staffDevice.getByRole('heading', { level: 2, name: 'Audit log', exact: true })).toBeVisible()
        await expect(staffDevice.getByText('Records cannot be edited or deleted', { exact: true })).toBeVisible()
        const row = staffDevice.locator('li').filter({ has: staffDevice.getByText(decisionReason, { exact: true }) })
        await expect(row).toHaveCount(1)
        await expect(row.getByRole('link', { name: moderator.displayName, exact: true })).toBeVisible()
        await expect(row.getByRole('link', { name: student.displayName, exact: true })).toBeVisible()
        await expect(row.locator('form, button, [contenteditable="true"]')).toHaveCount(0)
        await expect(staffDevice.getByText(studentListing.description, { exact: true })).toHaveCount(0)
        await expect(staffDevice.getByText(studentReport.detail, { exact: true })).toHaveCount(0)
        await staffDevice.reload()
        await expect(row).toHaveCount(1)
      }
      const response = await reporterPage.goto(studentListing.route)
      expect(response).not.toBeNull()
      expect([200, 404]).toContain(response!.status()) // Streaming notFound can retain 200.
      await expect(reporterPage.getByRole('heading', { level: 1, name: 'There is nothing at this address', exact: true })).toBeVisible()
      const html = await response!.text()
      expect(html.includes(studentListing.row.title)).toBe(false)
      expect(html.includes(studentListing.description)).toBe(false)
      secretFree(html)
    })

    const bugTitle = `Private synthetic bug title ${randomBytes(8).toString('hex')}`
    const bugBody = `Private synthetic environment detail ${randomBytes(8).toString('hex')}. This is an isolated acceptance report, not a real fault or credential.`
    let bugId = ''
    let triageWire: ActionWire | undefined
    await test.step('a student files a real bug; only the admin triages it and the reporter sees the durable status', async () => {
      await reporterPage.goto('/report-a-bug')
      await reporterPage.getByLabel(/^What went wrong, in one line/).fill(bugTitle)
      await reporterPage.getByLabel(/^What you did, what you expected, what happened/).fill(bugBody)
      await expect(reporterPage.getByLabel('The page you were on', { exact: true })).toHaveValue(`${origin}/report-a-bug`)
      await submit(reporterPage, reporterPage.getByRole('button', { name: 'Send report', exact: true }),
        () => expect(reporterPage.getByText('Report received', { exact: true })).toBeVisible())
      await expect(reporterPage.getByText('Report received', { exact: true })).toBeVisible()
      const rows = (await onlySyntheticSnapshot()).bug_reports ?? []
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        reporter_id: reporter.profileId, title: bugTitle, body: bugBody,
        page_url: `${origin}/report-a-bug`, status: 'open',
      })
      bugId = rows[0]!.id
      await adminPage.goto('/admin/bug-reports')
      const row = adminPage.locator('li').filter({
        has: adminPage.getByRole('heading', { level: 3, name: bugTitle, exact: true }),
      })
      await expect(row.getByText(bugBody, { exact: true })).toBeVisible()
      await expect(row.getByRole('link', { name: reporter.displayName, exact: true })).toBeVisible()
      await row.getByRole('combobox', { name: 'Status', exact: true }).selectOption('reviewed')
      const response = await submit(adminPage, row.getByRole('button', { name: 'Save', exact: true }), async () => {
        await expect.poll(async () => (await onlySyntheticSnapshot()).bug_reports?.find(row => row.id === bugId)?.status).toBe('reviewed')
        await expect(row.getByRole('status')).toHaveText('Saved.')
      })
      triageWire = await captureWire(response, bugId)
      expect((await onlySyntheticSnapshot()).bug_reports?.find(row => row.id === bugId)?.status).toBe('reviewed')
      await adminPage.reload()
      await expect(row.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('reviewed')
      // Move forward through another real control. Replaying the older command
      // would now change fixed -> reviewed if the non-admin guard were absent.
      await row.getByRole('combobox', { name: 'Status', exact: true }).selectOption('fixed')
      await submit(adminPage, row.getByRole('button', { name: 'Save', exact: true }), async () => {
        await expect.poll(async () => (await onlySyntheticSnapshot()).bug_reports?.find(row => row.id === bugId)?.status).toBe('fixed')
        await expect(row.getByRole('status')).toHaveText('Saved.')
      })
      await adminPage.reload()
      await expect(row.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('fixed')
      const final = (await onlySyntheticSnapshot()).bug_reports?.find(row => row.id === bugId)
      expect(final).toMatchObject({ reporter_id: reporter.profileId, title: bugTitle, body: bugBody, status: 'fixed' })
      await reporterPage.goto('/report-a-bug')
      const own = reporterPage.locator('section').filter({
        has: reporterPage.getByRole('heading', { level: 2, name: 'What you have sent', exact: true }),
      })
      await expect(own.getByRole('heading', { level: 3, name: bugTitle, exact: true })).toBeVisible()
      await expect(own.getByText('Fixed', { exact: true })).toBeVisible()
      await expect(own.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0)
    })
    if (!triageWire || !bugId) throw new Error('The real admin triage did not provide its non-admin guard probe.')
    const privateStaffData = [bugTitle, bugBody, decisionReason, studentReport.detail, selfReport.detail, adminReport.detail]
    await test.step('moderator/ordinary direct URLs and genuine action replays refuse without private bug/queue/audit serialization', async () => {
      await refusedPage(moderatorPage, '/admin/bug-reports', true, [bugTitle, bugBody])
      for (const route of ['/admin', '/admin/audit', '/admin/bug-reports']) {
        await refusedPage(studentPage, route, false, privateStaffData)
      }
      for (const [devicePage, account] of [[moderatorPage, moderator], [studentPage, student]] as const) {
        await refusedReplay(devicePage, account, triageWire!, 'That report was not changed.', [bugTitle, bugBody])
        await devicePage.goto('/report-a-bug')
        await expect(devicePage.getByRole('heading', { level: 3, name: bugTitle, exact: true })).toHaveCount(0)
        await expect(devicePage.getByText(bugBody, { exact: true })).toHaveCount(0)
      }
      expect((await onlySyntheticSnapshot()).bug_reports?.find(row => row.id === bugId)?.status).toBe('fixed')
      expect((await onlySyntheticSnapshot()).moderation_actions).toHaveLength(1)
    })

    const final = await onlySyntheticSnapshot()
    expect(final.users).toHaveLength(4)
    expect(final.user_roles?.map(row => row.role).sort()).toEqual(['admin', 'moderator'])
    expect(final.reports?.filter(row => row.status === 'open')).toHaveLength(2)
    expect(final.account_deletion_jobs ?? []).toHaveLength(0)
    expect(pageErrors, 'The bounded real staff journey raised a browser exception').toBe(0)
    await info.attach('staff-operations-outcome.json', {
      body: Buffer.from(JSON.stringify({
        mode: 'local', operator_created_new_staff: 2, student_signups: 2,
        actual_credential_logins: 4, moderator_self_target_refusals: 1,
        moderator_admin_target_refusals: 1, ordinary_moderation_action_refusals: 1,
        closed_report_retry_refusals: 1, non_admin_bug_action_refusals: 2,
        durable_moderation_decisions: final.moderation_actions?.length,
        durable_bug_status: final.bug_reports?.find(row => row.id === bugId)?.status,
        local_mfa: 'unsupported limitation shown',
        hosted_auth_mfa_postgrest_audit_immutability: 'not exercised',
        owner_data_used: false, initial_cookie_or_action_mocks: false,
      }, null, 2)),
      contentType: 'application/json',
    })
  } finally {
    for (const context of contexts) await context.close()
  }
})
