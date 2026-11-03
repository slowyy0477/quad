import {
  test, expect, type Browser, type BrowserContext, type Download,
  type Locator, type Page, type Response,
} from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tables } from '../../src/lib/local/db'
import type { AccountExport, DeletionReceipt } from '../../src/features/account/types'

/**
 * Run this spec ALONE, with one worker, zero retries, a NEW run ID, and the
 * fresh loopback webServer. No owner preview, reused server, cloud or seed data.
 * Pin BOTH LOCAL_DATA_PATH and BULLA_LOCAL_MEDIA_ROOT under that run's fixture.
 *
 * All accounts, sessions, posts, messages, memberships and transfers use real
 * signup/login and UI controls. The store is inspected read-only, never seeded,
 * reset or repaired here. Recorded real cookies are restored ONLY to prove
 * revoked-session rejection. No worker is invoked directly or through a mock.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const maxExportBytes = 2 * 1024 * 1024
const receiptStates = ['queued', 'processing', 'retry', 'blocked', 'failed', 'completed'] as const
const receiptPhases = ['media', 'content', 'auth', 'complete'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const exportSections = [
  'profile', 'posts', 'comments', 'messages', 'projects', 'project_memberships',
  'project_applications', 'project_invites_sent', 'project_invites_received',
  'project_stars', 'ideas', 'idea_votes', 'idea_interest',
  'connections', 'follows', 'blocks', 'profile_skills', 'profile_interests',
  'endorsements_given', 'achievements', 'semesters', 'courses', 'goals',
  'goal_milestones', 'daily_logs', 'opportunities', 'opportunity_saves', 'events',
  'event_attendees', 'post_likes', 'post_saves', 'notifications', 'reports',
  'bug_reports', 'university_requests',
] as const
const receiptCopy: Record<DeletionReceipt['state'], string> = {
  completed: 'Account cleanup is complete in this data store. Backup retention and independently held provider data are separate.',
  blocked: 'Cleanup needs an ownership or media review. Account access remains disabled; an operator must resolve the blocker before retrying.',
  failed: 'Cleanup needs operator attention after repeated failures. Account access remains disabled; this is not a completed deletion.',
  retry: 'Cleanup is waiting for a retry. Account access remains disabled; deletion is not complete yet.',
  processing: 'Cleanup is processing. Account access remains disabled; deletion is not complete yet.',
  queued: 'Your request is durably queued and account access is disabled. Cleanup has not completed yet.',
}

type Account = {
  userId: string
  profileId: string
  handle: string
  displayName: string
  email: string
  password: string
}
type Pair = {
  owner: Account
  peer: Account
  ownerPage: Page
  peerPage: Page
  openDevice(): Promise<Page>
}

let origin: string
let runRoot: string
let fixtureRoot: string
let fixtureFile: string
const knownUsers = new Set<string>()

test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' })

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Account lifecycle acceptance must stay inside its dedicated fixture directory.')
  }
}

function samePath(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function freshOrigin(baseURL: string | undefined) {
  if (!baseURL) throw new Error('A dedicated loopback baseURL is required.')
  const url = new URL(baseURL)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port || url.port === '3000' || process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Use a fresh loopback webServer on a dedicated port, never port 3000 or a reused server.')
  }
  return url.origin
}

async function readFixture(): Promise<Partial<Tables>> {
  assertInside(fixtureRoot, fixtureFile)
  const entry = await fs.lstat(fixtureFile)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 5 * 1024 * 1024) {
    throw new Error('Refusing to inspect a replaced or oversized account lifecycle fixture.')
  }
  assertInside(await fs.realpath(fixtureRoot), await fs.realpath(fixtureFile))
  const parsed: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some(rows => !Array.isArray(rows))) {
    throw new Error('Expected only array tables in the isolated account lifecycle fixture.')
  }
  return parsed as Partial<Tables>
}

// Playwright requires fixture destructuring even when this hook only uses testInfo.
test.beforeAll(async ({}, info) => {
  origin = freshOrigin(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
  const root = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(root) || !run || !/^[a-zA-Z0-9-]+$/.test(run)) {
    throw new Error('Use a new isolated Playwright run identifier for this spec.')
  }
  runRoot = path.resolve(root, run)
  assertInside(root, runRoot)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)
  fixtureRoot = path.join(runRoot, 'fixture')
  fixtureFile = path.join(fixtureRoot, 'local.json')

  // Inspect resolved configuration before any signup or account mutation.
  const server = info.config.webServer
  const env = server?.env
  if (!server || server.reuseExistingServer !== false || !server.url ||
    new URL(server.url).origin !== origin || env?.NEXT_PUBLIC_DATA_MODE !== 'local' ||
    env.NEXT_PUBLIC_SUPABASE_URL !== '' || env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' ||
    env.SUPABASE_SERVICE_ROLE_KEY !== '' || !env.LOCAL_DATA_PATH ||
    !samePath(env.LOCAL_DATA_PATH, fixtureFile) || !env.BULLA_LOCAL_MEDIA_ROOT ||
    !path.isAbsolute(env.BULLA_LOCAL_MEDIA_ROOT)) {
    throw new Error('The fresh webServer must explicitly isolate its data/media paths and clear cloud keys.')
  }
  assertInside(fixtureRoot, env.BULLA_LOCAL_MEDIA_ROOT)

  await fs.mkdir(fixtureRoot, { recursive: true })
  const actualRoot = await fs.realpath(root)
  const actualFixture = await fs.realpath(fixtureRoot)
  assertInside(actualRoot, actualFixture)
  if (process.platform === 'win32') assertInside(await fs.realpath(recoveryRoot), actualFixture)
  let snapshot: Partial<Tables> = {}
  try { snapshot = await readFixture() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Object.values(snapshot).some(rows => rows.length !== 0)) {
    throw new Error('This spec requires an empty fixture. Never reset another spec, account or budget.')
  }
  // Retain the exclusive marker even after failure. Retry only with a NEW run ID.
  const marker = await fs.open(path.join(fixtureRoot, 'account-lifecycle-fixture.marker'), 'wx', 0o600)
  await marker.close()
})

async function onlyLocalNetwork(context: BrowserContext) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['blob:', 'data:', 'about:'].includes(url.protocol)) {
      await route.continue()
    } else {
      await route.abort('blockedbyclient')
      throw new Error('Account lifecycle acceptance attempted a non-fixture network request.')
    }
  })
  await context.routeWebSocket(url => {
    const local = new URL(origin)
    return url.hostname !== local.hostname || url.port !== local.port || url.protocol !== 'ws:'
  }, socket => {
    socket.close({ code: 1008, reason: 'Loopback-only acceptance' })
    throw new Error('Account lifecycle acceptance attempted a non-fixture WebSocket.')
  })
}

test.beforeEach(async ({ context, baseURL }, info) => {
  if (freshOrigin(baseURL) !== origin || info.config.workers !== 1 ||
    info.project.retries !== 0 || info.project.repeatEach !== 1 || info.retry !== 0) {
    throw new Error('Run this spec alone with one worker, no retries/repeats, and the fresh webServer.')
  }
  assertInside(runRoot, info.outputDir)
  expect((await context.cookies()).some(cookie => cookie.name === 'quad_local_session')).toBe(false)
  let snapshot: Partial<Tables> = {}
  try { snapshot = await readFixture() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if ((snapshot.users ?? []).some(user => !knownUsers.has(user.id)) ||
    (snapshot.profiles ?? []).some(profile => !knownUsers.has(profile.user_id))) {
    throw new Error('Another spec changed this fixture; account lifecycle will not mutate it.')
  }
  await onlyLocalNetwork(context)
  info.annotations.push({
    type: 'local-only',
    description: 'Real isolated local UI/HTTP, not hosted Auth/MFA/PostgREST/Storage, worker deployment or backup recovery.',
  })
})

/** Require the exact POST and a bounded domain outcome, never RSC closure. */
async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const response = await completeAction(page, control, outcome)
  expect(response.status()).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

function section(page: Page, title: string) {
  return page.locator('section').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  })
}

function ownState(snapshot: Partial<Tables>, account: Account) {
  return {
    user: (snapshot.users ?? []).filter(row => row.id === account.userId),
    profile: (snapshot.profiles ?? []).filter(row => row.id === account.profileId),
    sessions: (snapshot.sessions ?? []).filter(row => row.user_id === account.userId),
    posts: (snapshot.posts ?? []).filter(row => row.author_id === account.profileId),
    messages: (snapshot.messages ?? []).filter(row => row.author_id === account.profileId),
    jobs: (snapshot.account_deletion_jobs ?? []).filter(row => row.user_id === account.userId),
  }
}

async function sessionCookie(page: Page, account: Account) {
  const cookie = (await page.context().cookies()).find(row => row.name === 'quad_local_session')
  expect(Boolean(cookie), 'The fixture must have a real opaque session').toBe(true)
  expect(cookie!.httpOnly).toBe(true)
  const snapshot = await readFixture()
  expect((snapshot.users ?? []).find(row => row.id === account.userId)?.email).toBe(account.email)
  expect((snapshot.profiles ?? []).find(row => row.id === account.profileId)?.user_id).toBe(account.userId)
  const digest = createHash('sha256').update(cookie!.value).digest('hex')
  expect((snapshot.sessions ?? []).some(row => row.user_id === account.userId && row.token_hash === digest)).toBe(true)
  return cookie!
}

async function signup(page: Page, handle: string, displayName: string): Promise<Account> {
  const email = `${handle}@example.test`
  const password = `Lifecycle-${randomBytes(24).toString('base64url')}-9Aa!`
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(email)
  await page.getByLabel(/^Password/).fill(password)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL(url => url.pathname === '/onboarding'))
  await expect(page).toHaveURL(url => url.pathname === '/onboarding')
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await page.getByLabel(/^Choose a username/).fill(handle)
  await page.getByLabel(/^Who can see your profile/).selectOption('public') // Explicit synthetic publication.
  await submit(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL(url => url.pathname === '/me')
    await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  })
  await expect(page).toHaveURL(url => url.pathname === '/me')
  await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  const snapshot = await readFixture()
  const profile = (snapshot.profiles ?? []).find(row => row.username === handle)
  expect(Boolean(profile)).toBe(true)
  const account = { userId: profile!.user_id, profileId: profile!.id, handle, displayName, email, password }
  knownUsers.add(account.userId)
  await sessionCookie(page, account)
  return account
}

async function login(page: Page, account: Account) {
  expect((await page.context().cookies()).some(row => row.name === 'quad_local_session')).toBe(false)
  await page.goto('/login')
  await page.getByLabel(/^Email address/).fill(account.email)
  await page.getByLabel(/^Password/).fill(account.password)
  await submit(page, page.getByRole('button', { name: 'Sign in', exact: true }),
    () => expect(page).toHaveURL(url => url.pathname === '/feed'))
  await expect(page).toHaveURL(url => url.pathname === '/feed')
  return sessionCookie(page, account)
}

async function withPair(browser: Browser, ownerPage: Page, flow: string, journey: (pair: Pair) => Promise<void>) {
  const contexts: BrowserContext[] = []
  const errors: string[] = []
  ownerPage.on('pageerror', error => errors.push(`Owner: ${error.message}`))
  async function openDevice() {
    const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block', acceptDownloads: true })
    contexts.push(context)
    await onlyLocalNetwork(context)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`Synthetic device: ${error.message}`))
    return page
  }
  try {
    const peerPage = await openDevice()
    const suffix = randomBytes(6).toString('hex')
    const owner = await signup(ownerPage, `life_${flow}_a_${suffix}`, `Lifecycle owner ${suffix}`)
    const peer = await signup(peerPage, `life_${flow}_b_${suffix}`, `Lifecycle peer ${suffix}`)
    await journey({ owner, peer, ownerPage, peerPage, openDevice })
    expect(errors).toEqual([])
  } finally {
    for (const context of contexts) await context.close()
  }
}

async function createPost(page: Page, account: Account, body: string, visibility: 'private' | 'public') {
  await page.goto('/feed')
  await page.getByRole('textbox', { name: 'Post body', exact: true }).fill(body)
  await page.getByRole('combobox', { name: 'Visible to', exact: true }).selectOption(visibility)
  await submit(page, page.getByRole('button', { name: 'Post', exact: true }), async () => {
    await expect(page.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
    await expect(page.getByText(body, { exact: true })).toBeVisible()
  })
  await expect(page.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
  await expect(page.getByText(body, { exact: true })).toBeVisible()
  const rows = (await readFixture()).posts?.filter(row => row.author_id === account.profileId && row.body === body) ?? []
  expect(rows).toHaveLength(1)
  expect(rows[0]!.visibility).toBe(visibility)
  return rows[0]!
}

async function allowIncoming(page: Page) {
  await page.goto('/settings')
  await page.getByRole('radio', { name: /^Anyone on Bulla/ }).check()
  await submit(page, page.getByRole('button', { name: 'Save privacy settings', exact: true }),
    () => expect(page.getByText('Privacy settings saved.', { exact: true })).toBeVisible())
  await expect(page.getByText('Privacy settings saved.', { exact: true })).toBeVisible()
}

async function sendMessage(page: Page, account: Account, body: string) {
  const thread = page.locator('section[aria-labelledby="thread-heading"]')
  await thread.getByRole('textbox', { name: 'Message', exact: true }).fill(body)
  await submit(page, thread.getByRole('button', { name: 'Send', exact: true }), async () => {
    await expect(thread.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
    await expect(thread.getByText(body, { exact: true })).toHaveCount(1)
  })
  await expect(thread.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
  await expect(thread.getByText(body, { exact: true })).toHaveCount(1)
  expect((await readFixture()).messages?.filter(row => row.author_id === account.profileId && row.body === body)).toHaveLength(1)
}

async function exchangeMessages(pair: Pair, outgoing: string, incoming: string) {
  await allowIncoming(pair.ownerPage)
  await allowIncoming(pair.peerPage)
  await pair.ownerPage.goto('/messages')
  const start = pair.ownerPage.locator('aside details:has(> summary:text-is("New message"))')
  await start.locator(':scope > summary:text-is("New message")').click()
  await start.getByRole('textbox', { name: /^Their handle/ }).fill(pair.peer.handle)
  await submit(pair.ownerPage, start.getByRole('button', { name: 'Start conversation', exact: true }),
    () => expect(pair.ownerPage).toHaveURL(url => url.pathname === '/messages' && Boolean(url.searchParams.get('c'))))
  await expect(pair.ownerPage).toHaveURL(url => url.pathname === '/messages' && Boolean(url.searchParams.get('c')))
  const conversationPath = `/messages?c=${encodeURIComponent(new URL(pair.ownerPage.url()).searchParams.get('c')!)}`
  await sendMessage(pair.ownerPage, pair.owner, outgoing)
  await pair.peerPage.goto(conversationPath)
  await sendMessage(pair.peerPage, pair.peer, incoming)
  return conversationPath
}

function privateHeaders(response: Response) {
  const headers = response.headers()
  expect(headers['cache-control']).toContain('private')
  expect(headers['cache-control']).toContain('no-store')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['vary']?.toLowerCase()).toContain('cookie')
  expect(headers['vary']?.toLowerCase()).toContain('authorization')
}

async function accountAction(page: Page, endpoint: string, control: Locator) {
  const [response] = await Promise.all([
    page.waitForResponse(candidate => {
      const url = new URL(candidate.url())
      return candidate.request().method() === 'POST' && url.origin === origin && url.pathname === endpoint
    }, { timeout: 60_000 }),
    control.click(),
  ])
  expect(new URL(response.url()).search).toBe('')
  // This is a finite JSON Route Handler, not a streamed Server Action.
  // Keep actual transport/body completion and every caller's JSON contract.
  await response.body()
  privateHeaders(response)
  return response
}

async function downloadText(download: Download) {
  expect(download.suggestedFilename()).toBe('bulla-account-export.json')
  const stream = await download.createReadStream()
  if (!stream) throw new Error('The real export did not produce a readable download.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxExportBytes) throw new Error('Export download exceeds the two-MiB contract.')
    chunks.push(bytes)
  }
  expect(await download.failure()).toBeNull()
  return Buffer.concat(chunks).toString('utf8')
}

async function exportDownload(page: Page, account: Account) {
  await sessionCookie(page, account)
  const controls = section(page, 'Export your data')
  await controls.getByLabel('Current password', { exact: true }).fill(account.password)
  const [download, response] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    accountAction(page, '/api/account/export', controls.getByRole('button', { name: 'Download own data', exact: true })),
  ])
  expect(response.status()).toBe(200)
  expect(response.headers()['content-disposition']).toContain('attachment')
  const text = await downloadText(download)
  expect(text).toBe(JSON.stringify(await response.json()))
  await expect(controls.getByLabel('Current password', { exact: true })).toHaveValue('')
  await expect(controls.getByRole('button', { name: 'Download own data', exact: true })).toBeEnabled()
  await expect(controls.getByRole('status')).toContainText('Export downloaded.')
  return { text, value: JSON.parse(text) as AccountExport }
}

function sensitiveKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(sensitiveKeys)
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/(?:^|_)(?:password|token|session|secret|salt|mfa|amr|aal|nonce|lease)(?:_|$)/i.test(key) ||
      ['auth', 'user_metadata', 'app_metadata', 'raw_user_meta_data', 'raw_app_meta_data',
        'identity_data', 'identities', 'user_roles', 'idempotency_key'].includes(key) ? [key] : []),
    ...sensitiveKeys(child),
  ])
}

async function secretCanaries(accounts: Account[], pages: Page[]) {
  const snapshot = await readFixture()
  const cookies = (await Promise.all(pages.map(page => page.context().cookies()))).flat()
  return [
    ...accounts.map(account => account.password),
    ...(snapshot.users ?? []).map(row => row.password_hash),
    ...(snapshot.sessions ?? []).map(row => row.token_hash),
    ...cookies.filter(row => row.name === 'quad_local_session').map(row => row.value),
  ].filter(Boolean)
}

function secretFreeExport(value: AccountExport, text: string, account: Account, canaries: string[], limit: number) {
  expect(Object.keys(value).sort()).toEqual([
    'complete_for_selected_sections', 'continuation', 'excluded', 'generated_at',
    'mode', 'policy_version', 'schema_version', 'sections', 'subject',
  ])
  expect(value.schema_version).toBe(1)
  expect(value.mode).toBe('local')
  expect(value.subject).toEqual({ user_id: account.userId, profile_id: account.profileId, email: account.email })
  expect(value.continuation).toEqual({ method: 'POST', path: '/api/account/export', reauthenticate_each_page: true })
  expect(sensitiveKeys(value)).toEqual([])
  for (const canary of canaries) expect(text.includes(canary), 'A synthetic credential/hash/cookie leaked').toBe(false)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maxExportBytes)
  for (const [name, result] of Object.entries(value.sections)) {
    expect(exportSections).toContain(name)
    expect(result!.records.length).toBeLessThanOrEqual(limit)
    expect(result!.next_cursor === null || typeof result!.next_cursor === 'string').toBe(true)
    for (const record of result!.records) {
      expect(Object.values(record).every(field => field === null ||
        ['string', 'boolean', 'number'].includes(typeof field))).toBe(true)
    }
  }
}

async function fillDeletion(page: Page, password: string, confirmation = 'DELETE MY ACCOUNT') {
  const controls = section(page, 'Delete your account')
  await controls.getByLabel('Current password', { exact: true }).fill(password)
  await controls.getByLabel('Type DELETE MY ACCOUNT exactly', { exact: true }).fill(confirmation)
  await controls.getByRole('checkbox', { name: /^I understand this policy/ }).check()
  return controls
}

async function receiptResponse(response: Response, withheld: string[]) {
  expect([200, 202]).toContain(response.status())
  const result = await response.json() as { ok: boolean; value: DeletionReceipt }
  expect(Object.keys(result).sort()).toEqual(['ok', 'value'])
  expect(result.ok).toBe(true)
  expect(Object.keys(result.value).sort()).toEqual(['id', 'phase', 'state'])
  expect(result.value.id).toMatch(uuid)
  expect(receiptStates).toContain(result.value.state)
  expect(receiptPhases).toContain(result.value.phase)
  expect(result.value.phase === 'complete').toBe(result.value.state === 'completed')
  const text = JSON.stringify(result)
  for (const canary of withheld) expect(text.includes(canary), 'A receipt exposed synthetic identity or credentials').toBe(false)
  return result.value
}

test('real signup/login, wrong reauthentication and bounded secret-free own-data downloads', async ({ page, browser }) => {
  test.setTimeout(360_000)
  await withPair(browser, page, 'export', async pair => {
    const { owner, peer, ownerPage, peerPage, openDevice } = pair
    const otherDevice = await openDevice()
    await login(otherDevice, owner)
    const ownPublic = `Lifecycle exported public post ${owner.handle}`
    const ownPrivate = `Lifecycle exported private post ${owner.handle}`
    const peerPrivate = `Lifecycle NEVER export peer private post ${peer.handle}`
    const outgoing = `Lifecycle exported OWN sent message ${owner.handle}`
    const incoming = `Lifecycle NEVER export incoming peer message ${peer.handle}`
    await createPost(ownerPage, owner, ownPublic, 'public')
    await createPost(ownerPage, owner, ownPrivate, 'private')
    await createPost(peerPage, peer, peerPrivate, 'private')
    await exchangeMessages(pair, outgoing, incoming)
    const canaries = await secretCanaries([owner, peer], [ownerPage, peerPage, otherDevice])
    await ownerPage.goto('/settings/account')
    await expect(ownerPage.getByRole('heading', { level: 1, name: 'Account data and deletion', exact: true })).toBeVisible()
    await expect(ownerPage.getByRole('link', { name: 'Back to settings', exact: true })).toHaveAttribute('href', '/settings')
    const controls = section(ownerPage, 'Export your data')
    await expect(controls.getByLabel('Current password', { exact: true })).toHaveAttribute('autocomplete', 'current-password')
    await expect(controls.getByLabel('Authenticator code (if enrolled)', { exact: true })).toHaveCount(0)
    await controls.getByRole('spinbutton', { name: 'Rows per section', exact: true }).fill('1')
    let downloads = 0
    ownerPage.on('download', () => { downloads += 1 })

    await test.step('wrong password refuses without a download, deletion job or revoked session', async () => {
      const before = ownState(await readFixture(), owner)
      await controls.getByLabel('Current password', { exact: true }).fill(`Wrong-${randomBytes(24).toString('hex')}`)
      const response = await accountAction(ownerPage, '/api/account/export',
        controls.getByRole('button', { name: 'Download own data', exact: true }))
      expect(response.status()).toBe(403)
      expect(await response.json()).toMatchObject({ ok: false, code: 'invalid_password' })
      await expect(controls.getByRole('alert')).toHaveText('That current password could not be verified.')
      await expect(controls.getByLabel('Current password', { exact: true })).toHaveValue('')
      expect(downloads).toBe(0)
      expect(ownState(await readFixture(), owner)).toEqual(before)
      await sessionCookie(ownerPage, owner)
    })

    const first = await exportDownload(ownerPage, owner)
    secretFreeExport(first.value, first.text, owner, canaries, 1)
    expect(Object.keys(first.value.sections).sort()).toEqual([...exportSections].sort())
    expect(first.value.sections.profile!.records.map(row => row.id)).toEqual([owner.profileId])
    expect(first.value.sections.profile!.next_cursor).toBeNull()
    expect(first.value.sections.messages!.records.map(row => row.body)).toEqual([outgoing])
    expect(first.value.sections.messages!.next_cursor).toBeNull()
    expect(first.value.complete_for_selected_sections).toBe(false)
    for (const withheld of [peerPrivate, incoming, peer.email]) expect(first.text.includes(withheld)).toBe(false)
    expect(first.value.sections.posts!.next_cursor).toBeTruthy()

    await test.step('the next page selects its real cursor, focuses verification and reauthenticates again', async () => {
      await ownerPage.getByRole('button', { name: 'Next page: Own posts', exact: true }).click()
      await expect(controls.getByRole('combobox', { name: 'Data section', exact: true })).toHaveValue('posts')
      await expect(controls.getByRole('textbox', { name: 'Next-page cursor (optional)', exact: true })).toHaveValue(first.value.sections.posts!.next_cursor!)
      await expect(controls.getByLabel('Current password', { exact: true })).toBeFocused()
      await controls.getByLabel('Current password', { exact: true }).fill(`Wrong-page-${randomBytes(24).toString('hex')}`)
      const refused = await accountAction(ownerPage, '/api/account/export',
        controls.getByRole('button', { name: 'Download own data', exact: true }))
      expect(refused.status()).toBe(403)
      await expect(controls.getByRole('alert')).toHaveText('That current password could not be verified.')
      await expect(controls.getByLabel('Current password', { exact: true })).toHaveValue('')
      expect(downloads).toBe(1)
      const next = await exportDownload(ownerPage, owner)
      secretFreeExport(next.value, next.text, owner, canaries, 1)
      expect(Object.keys(next.value.sections)).toEqual(['posts'])
      expect(next.value.sections.posts!.next_cursor).toBeNull()
      expect(next.value.complete_for_selected_sections).toBe(true)
      const records = [...first.value.sections.posts!.records, ...next.value.sections.posts!.records]
      expect(new Set(records.map(row => row.id)).size).toBe(2)
      expect(records.map(row => row.body).sort()).toEqual([ownPublic, ownPrivate].sort())
      expect(downloads).toBe(2)
    })
  })
})

test('shared-project ownership blocks deletion, including stale UI; transfer is exercised only when offered', async ({ page, browser }, info) => {
  test.setTimeout(360_000)
  await withPair(browser, page, 'owner', async ({ owner, peer, ownerPage, peerPage, openDevice }) => {
    const stalePage = await openDevice()
    await login(stalePage, owner)
    await stalePage.goto('/settings/account')
    await expect(section(stalePage, 'Delete your account').getByRole('button', { name: 'Confirm account deletion', exact: true })).toBeEnabled()
    const title = `Lifecycle shared project ${owner.handle}`
    await ownerPage.goto('/projects/new')
    await ownerPage.getByLabel(/^Title/).fill(title)
    await ownerPage.getByRole('textbox', { name: 'One-line purpose', exact: true }).fill('A synthetic ownership-transfer acceptance project')
    await ownerPage.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('public')
    await ownerPage.getByRole('checkbox', { name: /^This project is looking for people/ }).check()
    await ownerPage.getByRole('spinbutton', { name: 'Team size you are aiming for', exact: true }).fill('3')
    await submit(ownerPage, ownerPage.getByRole('button', { name: 'Create project', exact: true }), async () => {
      await expect(ownerPage).toHaveURL(url => /^\/projects\/[^/]+$/.test(url.pathname))
      await expect(ownerPage.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
    })
    await expect(ownerPage).toHaveURL(url => /^\/projects\/[^/]+$/.test(url.pathname))
    const projectPath = new URL(ownerPage.url()).pathname
    const project = (await readFixture()).projects?.find(row => `/projects/${row.slug}` === projectPath)
    expect(project?.owner_id).toBe(owner.profileId)
    expect(project?.visibility).toBe('public')
    await peerPage.goto(projectPath)
    await peerPage.getByRole('textbox', { name: 'Note to the owners', exact: true }).fill('Synthetic peer accepting shared project responsibility')
    await submit(peerPage, peerPage.getByRole('button', { name: 'Ask to join', exact: true }),
      () => expect(peerPage.getByText('Your request is with the project', { exact: true })).toBeVisible())
    await expect(peerPage.getByText('Your request is with the project', { exact: true })).toBeVisible()
    await ownerPage.reload()
    await ownerPage.getByRole('tab', { name: 'Requests', exact: true }).click()
    await expect(ownerPage).toHaveURL(url => url.pathname === projectPath && url.searchParams.get('tab') === 'requests')
    await expect(ownerPage.getByRole('tab', { name: 'Requests', exact: true })).toHaveAttribute('aria-selected', 'true')
    const requests = ownerPage.getByRole('tabpanel', { name: 'Requests', exact: true })
    await expect(requests).toBeVisible()
    const application = requests.locator('li').filter({
      has: ownerPage.getByRole('link', { name: peer.displayName, exact: true }),
    })
    await submit(ownerPage, application.getByRole('button', { name: 'Accept', exact: true }), async () => {
      await expect.poll(async () => (await readFixture()).project_members?.some(row =>
        row.project_id === project!.id && row.profile_id === peer.profileId && row.role === 'member')).toBe(true)
      await expect(application).toHaveCount(0)
    })
    await expect(application).toHaveCount(0)
    expect((await readFixture()).project_members?.some(row =>
      row.project_id === project!.id && row.profile_id === peer.profileId && row.role === 'member')).toBe(true)

    await test.step('fresh controls are disabled and the still-enabled stale form is refused server-side', async () => {
      await ownerPage.goto('/settings/account')
      const deletion = section(ownerPage, 'Delete your account')
      await expect(deletion.getByRole('alert')).toContainText('Deletion is blocked until ownership is resolved. No deletion has been queued.')
      await expect(deletion.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', projectPath)
      await expect(deletion.getByRole('button', { name: 'Confirm account deletion', exact: true })).toBeDisabled()
      await expect(deletion.getByLabel('Current password', { exact: true })).toBeDisabled()
      const before = ownState(await readFixture(), owner)
      await sessionCookie(stalePage, owner)
      const staleControls = await fillDeletion(stalePage, owner.password)
      const response = await accountAction(stalePage, '/api/account/deletion',
        staleControls.getByRole('button', { name: 'Confirm account deletion', exact: true }))
      expect(response.status()).toBe(409)
      expect(await response.json()).toMatchObject({ ok: false, code: 'ownership_transfer_required' })
      await expect(staleControls.getByRole('alert')).toHaveText('Transfer your shared projects before deleting your account. Soft deletion alone does not resolve ownership.')
      expect(ownState(await readFixture(), owner)).toEqual(before)
      expect((await readFixture()).projects?.find(row => row.id === project!.id)?.owner_id).toBe(owner.profileId)
      await sessionCookie(stalePage, owner)
    })

    await ownerPage.goto(projectPath)
    const member = section(ownerPage, 'Team').locator('li').filter({
      has: ownerPage.getByRole('link', { name: peer.displayName, exact: true }),
    })
    await expect(member).toBeVisible()
    const transfer = member.getByRole('button', { name: 'Make owner', exact: true })
    if (await transfer.count() === 0) {
      info.annotations.push({
        type: 'coverage-gap',
        description: 'Shared-project blocker and stale-form refusal were exercised, but no ownership-transfer control was offered. No transfer or deletion was fabricated.',
      })
      return
    }
    await transfer.click()
    const dialog = ownerPage.getByRole('dialog', { name: `Make ${peer.displayName} the owner of ${title}?`, exact: true })
    await expect(dialog).toContainText('You stay on the project as a maintainer.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await readFixture()).projects?.find(row => row.id === project!.id)?.owner_id).toBe(owner.profileId)
    await transfer.click()
    await submit(ownerPage, dialog.getByRole('button', { name: `Transfer ownership to ${peer.displayName}`, exact: true }), async () => {
      await expect.poll(async () => (await readFixture()).projects?.find(row => row.id === project!.id)?.owner_id).toBe(peer.profileId)
      await expect(member.locator('span').filter({ hasText: /^Owner$/ })).toBeVisible()
    })
    await expect.poll(async () => (await readFixture()).projects?.find(row => row.id === project!.id)?.owner_id).toBe(peer.profileId)
    await ownerPage.goto(projectPath)
    await expect(member.locator('span').filter({ hasText: /^Owner$/ })).toBeVisible()
    expect((await readFixture()).project_members?.find(row =>
      row.project_id === project!.id && row.profile_id === owner.profileId)?.role).toBe('maintainer')
    await ownerPage.goto('/settings/account')
    await expect(section(ownerPage, 'Delete your account').getByRole('button', { name: 'Confirm account deletion', exact: true })).toBeEnabled()
    await peerPage.goto('/settings/account')
    await expect(section(peerPage, 'Delete your account').getByRole('alert')).toContainText('Deletion is blocked until ownership is resolved.')
    // Transfer is real; neither remaining project member is deleted in this case.
  })
})

test('synthetic deletion confirmation, status-only receipt, real-session replay rejection and neighboring privacy', async ({ page, browser }, info) => {
  test.setTimeout(420_000)
  await withPair(browser, page, 'delete', async pair => {
    const { owner, peer, ownerPage, peerPage, openDevice } = pair
    const otherDevice = await openDevice()
    const secondaryCookie = await login(otherDevice, owner)
    const primaryCookie = await sessionCookie(ownerPage, owner)
    expect(primaryCookie.value === secondaryCookie.value).toBe(false)
    const publicBody = `Lifecycle deleted public post ${owner.handle}`
    const privateBody = `Lifecycle deleted private post ${owner.handle}`
    const neighborBody = `Lifecycle preserved neighbor private post ${peer.handle}`
    const outgoing = `Lifecycle deleted OWN message ${owner.handle}`
    const incoming = `Lifecycle preserved NEIGHBOR message ${peer.handle}`
    const publicPost = await createPost(ownerPage, owner, publicBody, 'public')
    await createPost(ownerPage, owner, privateBody, 'private')
    await createPost(peerPage, peer, neighborBody, 'private')
    await exchangeMessages(pair, outgoing, incoming)
    await peerPage.goto(`/u/${owner.handle}`)
    await expect(peerPage.getByRole('heading', { level: 1, name: owner.displayName, exact: true })).toBeVisible()
    await peerPage.goto(`/post/${publicPost.id}`)
    await expect(peerPage.getByText(publicBody, { exact: true })).toBeVisible()
    const protectedNeighbor = ownState(await readFixture(), peer)
    const canaries = await secretCanaries([owner, peer], [ownerPage, peerPage, otherDevice])
    await ownerPage.goto('/settings/account')
    const deletion = section(ownerPage, 'Delete your account')
    await expect(deletion.getByRole('button', { name: 'Confirm account deletion', exact: true })).toBeEnabled()
    await expect(deletion.getByLabel('Type DELETE MY ACCOUNT exactly', { exact: true })).toHaveAttribute('aria-describedby', 'account-deletion-policy')
    await expect(deletion.getByRole('checkbox', { name: /^I understand this policy/ })).toHaveAttribute('required', '')
    await expect(deletion.getByRole('checkbox', { name: /^I understand this policy/ })).not.toBeChecked()
    let deletionRequests = 0
    ownerPage.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/account/deletion') deletionRequests += 1
    })
    const before = ownState(await readFixture(), owner)

    await test.step('the exact confirmation is required, and wrong credentials never queue deletion', async () => {
      await fillDeletion(ownerPage, owner.password, 'delete my account')
      await deletion.getByRole('button', { name: 'Confirm account deletion', exact: true }).click()
      await expect(deletion.getByRole('alert')).toHaveText('Type DELETE MY ACCOUNT exactly and acknowledge the deletion policy.')
      expect(deletionRequests).toBe(0)
      expect(ownState(await readFixture(), owner)).toEqual(before)
      await fillDeletion(ownerPage, `Wrong-delete-${randomBytes(24).toString('hex')}`)
      const refused = await accountAction(ownerPage, '/api/account/deletion',
        deletion.getByRole('button', { name: 'Confirm account deletion', exact: true }))
      expect(refused.status()).toBe(403)
      expect(await refused.json()).toMatchObject({ ok: false, code: 'invalid_password' })
      await expect(deletion.getByRole('alert')).toHaveText('That current password could not be verified.')
      await expect(deletion.getByLabel('Current password', { exact: true })).toHaveValue('')
      expect(deletionRequests).toBe(1)
      expect(ownState(await readFixture(), owner)).toEqual(before)
      await sessionCookie(otherDevice, owner)
    })

    await sessionCookie(ownerPage, owner)
    await fillDeletion(ownerPage, owner.password)
    const accepted = await accountAction(ownerPage, '/api/account/deletion',
      deletion.getByRole('button', { name: 'Confirm account deletion', exact: true }))
    const withheld = [...canaries, owner.userId, owner.profileId, owner.email, owner.displayName, privateBody, incoming]
    const receipt = await receiptResponse(accepted, withheld)
    expect(deletionRequests).toBe(2)
    const panel = ownerPage.getByRole('region', { name: 'Deletion receipt', exact: true })
    await expect(panel.getByRole('textbox', { name: 'Deletion receipt', exact: true })).toHaveValue(receipt.id)
    await expect(panel.getByRole('status')).toHaveText(receiptCopy[receipt.state])
    await expect(deletion.getByRole('button', { name: 'Confirm account deletion', exact: true })).toHaveCount(0)
    expect((await ownerPage.context().cookies()).some(row => row.name === 'quad_local_session')).toBe(false)
    expect((await readFixture()).sessions?.filter(row => row.user_id === owner.userId)).toHaveLength(0)
    expect(ownState(await readFixture(), peer)).toEqual(protectedNeighbor)

    await test.step('both recorded real cookies fail closed on protected navigation and direct export replay', async () => {
      for (const [device, cookie] of [[ownerPage, primaryCookie], [otherDevice, secondaryCookie]] as const) {
        // Only replay the real cookie this test just obtained through signup/login.
        await device.context().addCookies([cookie])
        await device.goto('/settings/account')
        await expect(device).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('next') === '/settings/account')
        await expect(device.getByRole('heading', { level: 1, name: 'Account data and deletion', exact: true })).toHaveCount(0)
        // Reinsert if navigation cleared it; this HTTP refusal is not a cookie-clearing-only test.
        await device.context().addCookies([cookie])
        const replay = await device.context().request.post(`${origin}/api/account/export`, {
          headers: { origin, 'Content-Type': 'application/json' },
          data: { password: owner.password, section: 'profile', limit: 1 }, maxRedirects: 0,
        })
        expect(replay.status()).toBe(401)
        expect(await replay.json()).toMatchObject({ ok: false, code: 'signed_out' })
      }
      expect((await readFixture()).sessions?.filter(row => row.user_id === owner.userId)).toHaveLength(0)
    })

    const observer = await openDevice()
    let currentReceipt = receipt
    await test.step('an anonymous checker reads only the random receipt and does not revive access or mutate jobs', async () => {
      await observer.goto('/settings/account/deletion')
      await expect(observer).toHaveURL(url => url.pathname === '/settings/account/deletion' && !url.search)
      await expect(observer.getByRole('heading', { level: 1, name: 'Check a deletion receipt', exact: true })).toBeVisible()
      const checker = observer.getByRole('region', { name: 'Deletion receipt', exact: true })
      const input = checker.getByRole('textbox', { name: 'Deletion receipt', exact: true })
      await input.fill(receipt.id)
      const jobsBefore = (await readFixture()).account_deletion_jobs
      const checked = await accountAction(observer, '/api/account/deletion/status',
        checker.getByRole('button', { name: 'Check cleanup status', exact: true }))
      expect(checked.status()).toBe(200)
      expect(checked.request().postDataJSON()).toEqual({ receipt: receipt.id })
      currentReceipt = await receiptResponse(checked, withheld)
      expect(currentReceipt.id).toBe(receipt.id)
      await expect(checker.getByRole('status')).toHaveText(receiptCopy[currentReceipt.state])
      expect((await observer.context().cookies()).some(row => row.name === 'quad_local_session')).toBe(false)
      expect((await readFixture()).account_deletion_jobs).toEqual(jobsBefore)
      await input.fill(randomUUID())
      const missing = await accountAction(observer, '/api/account/deletion/status',
        checker.getByRole('button', { name: 'Check cleanup status', exact: true }))
      expect(missing.status()).toBe(404)
      expect(await missing.json()).toMatchObject({ ok: false, code: 'not_found' })
      await expect(checker.getByRole('alert')).toHaveText('That receipt could not be checked. It may be unavailable, invalid or expired.')
      expect((await readFixture()).account_deletion_jobs).toEqual(jobsBefore)
      await observer.goto('/settings/account')
      await expect(observer).toHaveURL(url => url.pathname === '/login')
    })

    await test.step('removed or disabled profiles/content stay private while the neighbor remains intact', async () => {
      for (const viewer of [peerPage, observer]) {
        for (const route of [`/u/${owner.handle}`, `/post/${publicPost.id}`]) {
          const response = await viewer.goto(route)
          expect(response).not.toBeNull()
          // Next may begin streaming with 200 before notFound(). Check refusal and serialized content.
          expect([200, 404]).toContain(response!.status())
          await expect(viewer.getByRole('heading', { level: 1, name: 'There is nothing at this address', exact: true })).toBeVisible()
          const html = await response!.text()
          for (const hidden of [owner.displayName, publicBody, privateBody]) {
            expect(html.includes(hidden), 'Deleted/disabled account content was serialized to another viewer').toBe(false)
            await expect(viewer.getByText(hidden, { exact: true })).toHaveCount(0)
          }
        }
      }
      expect(ownState(await readFixture(), peer)).toEqual(protectedNeighbor)
      await peerPage.goto('/feed')
      await expect(peerPage.getByText(neighborBody, { exact: true })).toBeVisible()
      await sessionCookie(peerPage, peer)
      await peerPage.goto('/settings/account')
      const peerDownload = await exportDownload(peerPage, peer)
      secretFreeExport(peerDownload.value, peerDownload.text, peer, canaries, 25)
      expect(peerDownload.value.sections.messages!.records.map(row => row.body)).toEqual([incoming])
      for (const hidden of [owner.email, privateBody, outgoing]) expect(peerDownload.text.includes(hidden)).toBe(false)
    })

    const finalSnapshot = await readFixture()
    if (currentReceipt.state === 'completed') {
      expect(currentReceipt.phase).toBe('complete')
      expect((finalSnapshot.users ?? []).some(row => row.id === owner.userId)).toBe(false)
      expect((finalSnapshot.profiles ?? []).some(row => row.id === owner.profileId)).toBe(false)
      expect((finalSnapshot.posts ?? []).some(row => row.author_id === owner.profileId)).toBe(false)
      expect((finalSnapshot.messages ?? []).some(row => row.author_id === owner.profileId)).toBe(false)
      expect(finalSnapshot.account_deletion_jobs?.find(row => row.id === receipt.id)).toMatchObject({
        state: 'completed', phase: 'complete', user_id: null, profile_id: null, idempotency_key: null,
      })
    } else {
      // A durable receipt is NOT a cleanup success. No worker/retry is fabricated.
      info.annotations.push({
        type: 'coverage-gap',
        description: `Receipt is ${currentReceipt.state}/${currentReceipt.phase}; access revocation and privacy were exercised, but cleanup completion/recovery remain unproved.`,
      })
      expect(finalSnapshot.account_deletion_jobs?.find(row => row.id === receipt.id)?.state).toBe(currentReceipt.state)
    }
    await info.attach('account-lifecycle-outcome.json', {
      body: Buffer.from(JSON.stringify({
        mode: 'local', receipt_state: currentReceipt.state, receipt_phase: currentReceipt.phase,
        cleanup_completion_observed: currentReceipt.state === 'completed',
        real_session_replays_refused: 2, neighboring_rows_preserved: true,
        hosted_worker_invoked: false, hosted_acceptance: 'not exercised',
      }, null, 2)),
      contentType: 'application/json',
    })
  })
})
