import {
  test, expect, type Browser, type BrowserContext, type Locator, type Page,
  type Request, type Response, type TestInfo,
} from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tables } from '../../src/lib/local/db'

/**
 * Real synthetic-cookie acceptance; main alone owns execution.
 * Run this spec ALONE through the existing per-spec browser-acceptance runner:
 * one fresh local webServer/store/media directory, one worker/project, no
 * retries/repeats, and an explicitly selected available browser channel.
 *
 * Four real UI-created accounts; six follows and two accepted connections.
 * No account/reference/notification seed writes, auth bypass, budget reset,
 * store repair, failed-fixture reuse, positional selector or error-as-success.
 * Fixture reads below verify only this run's synthetic durable outcomes.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const cookieName = 'quad_local_session'
const menuNames = {
  profile: 'Your profile',
  notifications: 'Notifications',
  campus: 'Campus workspace',
} as const
type HeaderMenu = keyof typeof menuNames
type Direction = 'followers' | 'following'
type Account = { handle: string; displayName: string; profileId: string; userId: string }
type Visibility = 'public' | 'private'

// Names come from the installed GraphList's separate own/public regions.
const graphRegions = {
  own: {
    followers: 'People who follow you',
    following: 'People you follow',
    connections: 'Your connections',
  },
  public: { followers: 'Followers', following: 'Following' },
} as const

const profileDestinations = [
  ['Your profile', '/me'],
  ['Edit your profile', '/me/edit'],
  ['Followers', '/connections/followers'],
  ['Following', '/connections/following'],
  ['Connections', '/connections'],
  ['Account & settings', '/settings'],
] as const

let origin: string
let runRoot: string
let fixtureRoot: string
let fixtureFile: string
const knownUsers = new Set<string>()

// Never record signup credentials, real cookies or session-bearing traces.
// Additional contexts below likewise have no recordVideo/trace setup.
test.use({
  storageState: { cookies: [], origins: [] },
  serviceWorkers: 'block',
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  colorScheme: 'light',
  contextOptions: { reducedMotion: 'no-preference' },
})

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Header/graph acceptance must stay inside its dedicated task-owned fixture directory.')
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
    throw new Error('Use a fresh HTTP loopback webServer on a dedicated port, never port 3000 or a reused server.')
  }
  return url.origin
}

function missingOnly(error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  return null
}

async function readFixture(): Promise<Partial<Tables>> {
  assertInside(fixtureRoot, fixtureFile)
  const directory = await fs.lstat(fixtureRoot)
  const entry = await fs.lstat(fixtureFile)
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
    !entry.isFile() || entry.isSymbolicLink() || entry.size > 5 * 1024 * 1024) {
    throw new Error('Refusing a replaced, linked or oversized synthetic header/graph fixture.')
  }
  assertInside(await fs.realpath(runRoot), await fs.realpath(fixtureRoot))
  assertInside(await fs.realpath(fixtureRoot), await fs.realpath(fixtureFile))
  const parsed: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some(rows => !Array.isArray(rows))) {
    throw new Error('Expected only array tables in the isolated header/graph fixture.')
  }
  return parsed as Partial<Tables>
}

async function requireFreshHarness(info: TestInfo) {
  origin = freshOrigin(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
  if (info.config.workers !== 1 || info.config.projects.length !== 1 ||
    info.config.fullyParallel || info.project.retries !== 0 || info.project.repeatEach !== 1) {
    throw new Error('Run only this spec, with one project/worker, no retries/repeats and a fresh run ID.')
  }
  const artifactRoot = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(artifactRoot) || !run || !/^[a-zA-Z0-9-]+$/.test(run)) {
    throw new Error('An absolute artifact root and fresh safe run identifier are required.')
  }
  runRoot = path.resolve(artifactRoot, run)
  fixtureRoot = path.join(runRoot, 'fixture')
  fixtureFile = path.join(fixtureRoot, 'local.json')
  assertInside(artifactRoot, runRoot)
  assertInside(runRoot, fixtureFile)
  assertInside(runRoot, info.outputDir)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)

  // Validate the RESOLVED server configuration, not just a test env flag.
  const server = info.config.webServer
  if (!server || !server.env || server.reuseExistingServer !== false ||
    !server.url || freshOrigin(server.url) !== origin) {
    throw new Error('The harness must start its own fresh matching loopback webServer.')
  }
  const env = server.env
  if (env.NEXT_PUBLIC_DATA_MODE !== 'local' || env.NEXT_PUBLIC_SITE_URL !== origin ||
    env.NEXT_PUBLIC_SUPABASE_URL !== '' || env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' ||
    env.SUPABASE_SERVICE_ROLE_KEY !== '' || !env.LOCAL_DATA_PATH ||
    !samePath(env.LOCAL_DATA_PATH, fixtureFile) || !env.BULLA_LOCAL_MEDIA_ROOT ||
    !path.isAbsolute(env.BULLA_LOCAL_MEDIA_ROOT)) {
    throw new Error('The webServer must explicitly isolate data/media and clear hosted credentials.')
  }
  const mediaRoot = path.resolve(env.BULLA_LOCAL_MEDIA_ROOT)
  assertInside(fixtureRoot, mediaRoot)
  await fs.mkdir(fixtureRoot, { recursive: true })
  const directory = await fs.lstat(fixtureRoot)
  const runDirectory = await fs.lstat(runRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
    !runDirectory.isDirectory() || runDirectory.isSymbolicLink()) {
    throw new Error('The fixture and run directories must be ordinary dedicated directories.')
  }
  const realRun = await fs.realpath(runRoot)
  assertInside(await fs.realpath(artifactRoot), realRun)
  assertInside(realRun, await fs.realpath(fixtureRoot))
  if (process.platform === 'win32') assertInside(await fs.realpath(recoveryRoot), realRun)
  await fs.mkdir(mediaRoot, { recursive: true })
  const mediaDirectory = await fs.lstat(mediaRoot)
  if (!mediaDirectory.isDirectory() || mediaDirectory.isSymbolicLink()) {
    throw new Error('Synthetic media may not resolve to an owner directory or symlink.')
  }
  assertInside(await fs.realpath(fixtureRoot), await fs.realpath(mediaRoot))

  if (await fs.lstat(`${fixtureFile}.lock`).catch(missingOnly)) {
    throw new Error('The isolated store is busy. Never remove a stale lock or reset a fixture.')
  }
  const entry = await fs.lstat(fixtureFile).catch(missingOnly)
  if (entry) {
    const snapshot = await readFixture()
    if (Object.values(snapshot).some(rows => rows.length !== 0)) {
      throw new Error('This spec refuses a nonempty store. Use a NEW run, never repair or reseed it.')
    }
  }
  // Exclusive wx ownership remains on failure; no unlink/reset in teardown.
  const marker = await fs.open(path.join(fixtureRoot, 'header-graph.marker'), 'wx', 0o600)
  await marker.close()
  await fs.mkdir(info.outputDir, { recursive: true })
  assertInside(realRun, await fs.realpath(info.outputDir))
}

// Real option fixtures provide valid Playwright destructuring without invoking
// the browser fixture here or an empty-pattern lint suppression.
test.beforeAll(async ({ browserName, channel }, info) => {
  const requested = process.env.BULLA_E2E_BROWSER ?? ''
  if (browserName !== 'chromium' || !['', 'chrome', 'msedge', 'chromium'].includes(requested) ||
    (channel ?? '') !== requested) {
    throw new Error('Use the requested supported Chromium channel exactly; no silent browser fallback.')
  }
  await requireFreshHarness(info)
})

async function onlyLocalNetwork(context: BrowserContext) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['blob:', 'data:', 'about:'].includes(url.protocol)) {
      await route.continue()
    } else {
      await route.abort('blockedbyclient')
      throw new Error('Header/graph acceptance attempted a non-fixture network request.')
    }
  })
  await context.routeWebSocket(url => {
    const local = new URL(origin)
    return url.protocol !== 'ws:' || url.hostname !== local.hostname || url.port !== local.port
  }, socket => {
    socket.close({ code: 1008, reason: 'Loopback-only acceptance' })
    throw new Error('Header/graph acceptance attempted a non-fixture WebSocket.')
  })
}

test.beforeEach(async ({ context, baseURL }, info) => {
  if (freshOrigin(baseURL) !== origin || info.config.workers !== 1 ||
    info.project.retries !== 0 || info.project.repeatEach !== 1 ||
    info.retry !== 0 || info.repeatEachIndex !== 0) {
    throw new Error('No reused origin, parallel worker, retry or repeated fixture is permitted.')
  }
  assertInside(runRoot, info.outputDir)
  expect((await context.cookies()).some(cookie => cookie.name === cookieName)).toBe(false)
  const entry = await fs.lstat(fixtureFile).catch(missingOnly)
  if (entry) {
    const snapshot = await readFixture()
    if ((snapshot.users ?? []).some(row => !knownUsers.has(row.id)) ||
      (snapshot.profiles ?? []).some(row => !knownUsers.has(row.user_id))) {
      throw new Error('Another spec changed this fixture; header/graph acceptance refuses it.')
    }
  }
  await onlyLocalNetwork(context)
  info.annotations.push({
    type: 'local-only',
    description: 'Real synthetic-cookie/UI acceptance; not hosted Auth/PostgREST/SQL, WCAG certification or load evidence.',
  })
})

/** Preserve the protected helper: exact action POST plus bounded real outcome. */
async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const response = await completeAction(page, control, outcome)
  expect(response.status()).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

function profilePath(account: Account) {
  return `/u/${account.handle}`
}

function header(page: Page) {
  return page.locator('header.app-header')
}

function trigger(page: Page, menu: HeaderMenu) {
  return header(page).getByRole('button', {
    name: menu === 'notifications' ? /^Notifications(?:, [1-9]\d* unread)?$/ :
      menu === 'campus' ? 'Open campus menu' : 'Your profile',
    exact: true,
  })
}

function panel(page: Page, menu: HeaderMenu) {
  return page.getByRole('dialog', { name: menuNames[menu], exact: true })
}

async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function visit(page: Page, pathname: string, heading?: string) {
  const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' })
  expect(response?.status(), 'An ordinary successful page must actually return 200').toBe(200)
  await expect(page).toHaveURL(url => url.origin === origin &&
    url.pathname === pathname && !url.search && !url.hash)
  if (heading) {
    await expect(page.locator('#main').getByRole('heading', {
      level: 1, name: heading, exact: true,
    })).toBeVisible()
  }
  return response!
}

// HTML/embedded Flight privacy evidence is a GET document, not the streaming
// action response. A bounded body-read refusal is not accepted as success.
async function documentText(response: Response) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The privacy document body did not complete.')), 20_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function unavailable(page: Page, pathname: string, withheld: readonly string[]) {
  const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' })
  expect(response).not.toBeNull()
  // Next can stream genuine notFound UI with 200; ordinary successes/actions
  // above do NOT receive this exception.
  expect([200, 404]).toContain(response!.status())
  await expect(page).toHaveURL(url => url.origin === origin && url.pathname === pathname)
  await expect(page.getByRole('heading', {
    level: 1, name: 'There is nothing at this address', exact: true,
  })).toBeVisible()
  const serialized = await documentText(response!)
  for (const value of withheld) {
    expect(serialized.includes(value), 'A refused document serialized withheld identity or a private edge').toBe(false)
  }
}

async function signup(
  page: Page, observer: Page, handle: string, displayName: string, visibility: Visibility,
): Promise<Account> {
  await visit(page, '/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(`${handle}@example.test`)
  await page.getByLabel(/^Password/).fill(`Header-${randomBytes(18).toString('base64url')}-9Aa!`)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL(url => url.pathname === '/onboarding'))
  const username = page.getByLabel(/^Choose a username/)
  const generated = await username.inputValue()
  expect(generated).not.toBe('')
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  const created = (await readFixture()).profiles?.find(row => row.username === generated)
  expect(Boolean(created && created.visibility === 'private' && created.onboarding_completed === false)).toBe(true)
  // A requested route handle itself may be echoed by Next's router. Withhold
  // the real name/record, not the already-known URL segment.
  await unavailable(observer, `/u/${encodeURIComponent(generated)}`, [displayName])
  await username.fill(handle)
  if (visibility === 'public') {
    await page.getByLabel(/^Who can see your profile/).selectOption('public') // Explicit publication consent.
  } // Casey leaves the actual private default untouched.
  await submit(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL(url => url.pathname === '/me')
    await expect(page.locator('#main').getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
    await expect(page.locator('#main')).toContainText(visibility === 'public'
      ? 'Anyone can see this profile, including people who are not signed in.'
      : 'Only you can see this profile.')
    await expect.poll(async () => (await readFixture()).profiles?.find(row => row.username === handle)?.visibility)
      .toBe(visibility)
  })
  const snapshot = await readFixture()
  const profile = snapshot.profiles?.find(row => row.username === handle)
  if (!profile) throw new Error('The real onboarding did not persist its profile.')
  expect(profile.onboarding_completed).toBe(true)
  expect(snapshot.users?.find(row => row.id === profile.user_id)?.email).toBe(`${handle}@example.test`)
  knownUsers.add(profile.user_id)
  const cookie = (await page.context().cookies()).find(row => row.name === cookieName)
  expect(Boolean(cookie)).toBe(true)
  expect(cookie?.httpOnly).toBe(true)
  const digest = createHash('sha256').update(cookie!.value).digest('hex')
  expect(snapshot.sessions?.some(row => row.user_id === profile.user_id && row.token_hash === digest)).toBe(true)
  const account = { handle, displayName, profileId: profile.id, userId: profile.user_id }
  if (visibility === 'public') await visit(observer, profilePath(account), displayName)
  else await unavailable(observer, profilePath(account), [displayName, profile.id])
  return account
}

async function setVisibility(page: Page, account: Account, visibility: Visibility) {
  await visit(page, '/me/edit', 'Edit your profile')
  await page.getByRole('combobox', { name: 'Profile visibility', exact: true }).selectOption(visibility)
  await submit(page, page.getByRole('button', { name: 'Save changes', exact: true }), async () => {
    await expect(page.locator('#main').getByText('Saved.', { exact: true })).toBeVisible()
    await expect.poll(async () => (await readFixture()).profiles?.find(row => row.id === account.profileId)?.visibility)
      .toBe(visibility)
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('combobox', { name: 'Profile visibility', exact: true })).toHaveValue(visibility)
}

function follows(snapshot: Partial<Tables>, from: Account, to: Account) {
  return (snapshot.follows ?? []).filter(row =>
    row.follower_id === from.profileId && row.following_id === to.profileId)
}

async function follow(page: Page, from: Account, to: Account) {
  await visit(page, profilePath(to), to.displayName)
  const main = page.locator('#main')
  await expect(main.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(1)
  await submit(page, main.getByRole('button', { name: 'Follow', exact: true }), async () => {
    await expect(main.getByRole('button', { name: 'Following', exact: true })).toBeVisible()
    await expect.poll(async () => follows(await readFixture(), from, to).length).toBe(1)
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(main.getByRole('button', { name: 'Following', exact: true })).toBeVisible()
  expect(follows(await readFixture(), from, to)).toHaveLength(1)
}

function connection(snapshot: Partial<Tables>, requester: Account, recipient: Account) {
  return (snapshot.connections ?? []).filter(row =>
    row.requester_id === requester.profileId && row.addressee_id === recipient.profileId)
}

async function connect(
  requesterPage: Page, recipientPage: Page, requester: Account, recipient: Account,
  verifyPendingOmission = false,
) {
  await visit(requesterPage, profilePath(recipient), recipient.displayName)
  await submit(requesterPage, requesterPage.locator('#main').getByRole('button', { name: 'Connect', exact: true }), async () => {
    await expect(requesterPage.locator('#main').getByText('Request sent', { exact: true })).toBeVisible()
    await expect.poll(async () => connection(await readFixture(), requester, recipient).map(row => row.status))
      .toEqual(['pending'])
  })
  if (verifyPendingOmission) {
    await visit(requesterPage, '/connections')
    const accepted = requesterPage.locator('#main').getByRole('region', {
      name: graphRegions.own.connections, exact: true,
    })
    await expect(accepted).toBeVisible()
    await expect(accepted.getByRole('link', { name: recipient.displayName, exact: true })).toHaveCount(0)
    expect(connection(await readFixture(), requester, recipient).map(row => row.status)).toEqual(['pending'])
  }
  await visit(recipientPage, profilePath(requester), requester.displayName)
  await submit(recipientPage, recipientPage.locator('#main').getByRole('button', {
    name: /^Accept the connection request from/,
  }), async () => {
    await expect(recipientPage.locator('#main').getByText('Connected', { exact: true })).toBeVisible()
    await expect.poll(async () => connection(await readFixture(), requester, recipient).map(row => row.status))
      .toEqual(['accepted'])
  })
  await requesterPage.goto(profilePath(recipient), { waitUntil: 'domcontentloaded' })
  await expect(requesterPage.locator('#main').getByRole('button', { name: 'Remove connection', exact: true })).toBeVisible()
  const rows = connection(await readFixture(), requester, recipient)
  expect(rows).toHaveLength(1)
  return rows[0].id
}

async function block(page: Page, blocker: Account, blocked: Account) {
  await visit(page, profilePath(blocked), blocked.displayName)
  await page.locator('#main').getByRole('button', { name: `Block ${blocked.displayName}`, exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: `Block ${blocked.displayName}?`, exact: true })
  await expect(confirmation).toBeVisible()
  await submit(page, confirmation.getByRole('button', { name: `Block ${blocked.displayName}`, exact: true }), async () => {
    await expect(confirmation).toHaveCount(0)
    await expect.poll(async () => (await readFixture()).blocks?.filter(row =>
      row.blocker_id === blocker.profileId && row.blocked_id === blocked.profileId).length).toBe(1)
  })
  // Only navigate after the action's dismissal AND durable block outcome.
  await unavailable(page, profilePath(blocked), [blocked.displayName, blocked.profileId])
}

function thread(page: Page) {
  return page.locator('section[aria-labelledby="thread-heading"]')
}

async function sendRealNotification(senderPage: Page, sender: Account, recipient: Account, suffix: string) {
  // Neither follows nor connection awards emit local notifications. This one
  // accepted UI send invokes notifyMessageLocal atomically; never seed a row.
  await visit(senderPage, '/messages', 'Messages')
  const disclosure = senderPage.locator('aside details').filter({
    has: senderPage.locator(':scope > summary').filter({ hasText: /^\s*New message\s*$/ }),
  })
  await expect(disclosure).toHaveCount(1)
  await disclosure.locator(':scope > summary').filter({ hasText: /^\s*New message\s*$/ }).click()
  await disclosure.getByRole('textbox', { name: /^Their handle/ }).fill(recipient.handle)
  await submit(senderPage, disclosure.getByRole('button', { name: 'Start conversation', exact: true }), async () => {
    await expect(senderPage).toHaveURL(url => url.pathname === '/messages' &&
      /^cnv_[a-z0-9]+$/.test(url.searchParams.get('c') ?? ''))
    await expect(thread(senderPage).getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  })
  const conversationId = new URL(senderPage.url()).searchParams.get('c')!
  const body = `Synthetic notification-only message ${suffix}; never include this body in the header.`
  const composer = thread(senderPage).locator('form').filter({ has: senderPage.locator('textarea[name="body"]') })
  await expect(composer).toHaveCount(1)
  const input = composer.getByRole('textbox', { name: 'Message', exact: true })
  // Editing before the first kept-draft snapshot is restored races hydration.
  // Observe the real guard and exact replacement, not a guessed ready marker.
  await expect(input).toBeEnabled()
  await expect(composer.getByRole('status').filter({ hasText: 'Loading your draft…' })).toHaveCount(0)
  await expect(input).toHaveValue('')
  await input.fill(body)
  await expect(input).toHaveValue(body)
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await submit(senderPage, composer.getByRole('button', { name: 'Send', exact: true }), async () => {
    await expect(input).toHaveValue('')
    await expect(thread(senderPage).getByText(body, { exact: true })).toHaveCount(1)
    await expect.poll(async () => (await readFixture()).messages?.filter(row =>
      row.conversation_id === conversationId && row.author_id === sender.profileId && row.body === body).length).toBe(1)
    await expect.poll(async () => (await readFixture()).notifications?.filter(row =>
      row.recipient_id === recipient.profileId && row.actor_id === sender.profileId &&
      row.type === 'message' && row.conversation_id === conversationId && !row.is_read).length).toBe(1)
  })
  const notification = (await readFixture()).notifications?.find(row =>
    row.recipient_id === recipient.profileId && row.actor_id === sender.profileId &&
    row.type === 'message' && row.conversation_id === conversationId)
  if (!notification) throw new Error('The real accepted message did not emit its recipient activity.')
  expect(notification.body).toBeNull()
  return { id: notification.id, conversationId, body }
}

async function withoutPost(page: Page, interaction: () => Promise<void>) {
  const posts: string[] = []
  const observe = (request: Request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
  }
  page.on('request', observe)
  try {
    await interaction()
    await rendered(page)
    expect(posts, 'Opening, switching, dismissing or styling a header menu must not post an action').toEqual([])
  } finally {
    page.off('request', observe)
  }
}

async function openMenu(page: Page, menu: HeaderMenu, keyboard = false) {
  const before = page.url()
  const control = trigger(page, menu)
  await expect(control).toHaveCount(1)
  await expect(control).toHaveAttribute('type', 'button')
  expect(await control.getAttribute('href')).toBeNull()
  if (keyboard) await control.press('Enter')
  else await control.click()
  await expect(page).toHaveURL(before)
  const content = panel(page, menu)
  await expect(content).toBeVisible()
  await expect(content).toHaveAttribute('aria-modal', 'false')
  await expect(content).toHaveAttribute('data-header-menu', menu)
  await expect(control).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-header-menu]')).toHaveCount(1)
  await expect(content.getByLabel('Close', { exact: true })).toHaveCount(1)
  expect(await page.locator('#main').evaluate(element => element.closest('[inert], [aria-hidden="true"]') === null))
    .toBe(true)
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).pointerEvents !== 'none')).toBe(true)
  return content
}

async function escapeMenu(page: Page, menu: HeaderMenu) {
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-header-menu]')).toHaveCount(0)
  await expect(trigger(page, menu)).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger(page, menu)).toBeFocused()
}

async function focusSignature(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || element === document.body) return null
    return {
      tag: element.tagName,
      id: element.id,
      href: element.getAttribute('href'),
      label: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '',
    }
  })
}

async function keyboardEdges(page: Page, menu: HeaderMenu) {
  const before = page.url()
  await trigger(page, menu).focus()
  await page.keyboard.press('Tab')
  const successor = await focusSignature(page)
  expect(successor, 'The closed inline trigger must have a real native forward-Tab successor').not.toBeNull()
  await expect(trigger(page, menu)).not.toBeFocused()
  await trigger(page, menu).focus()
  const content = await openMenu(page, menu, true)
  const close = content.getByLabel('Close', { exact: true })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-header-menu]')).toHaveCount(0)
  await expect(trigger(page, menu)).toBeFocused()
  await expect(page).toHaveURL(before)

  const reopened = await openMenu(page, menu, true)
  const last = menu === 'notifications'
    ? reopened.getByRole('link', { name: 'View all notifications', exact: true })
    : reopened.getByRole('button', { name: 'Sign out', exact: true })
  await expect(last).toHaveCount(1)
  // Traverse the actual controls, never jump to a guessed positional element.
  for (let step = 0; step < 32 && !await last.evaluate(element => element === document.activeElement); step++) {
    await page.keyboard.press('Tab')
    await expect(reopened).toBeVisible()
  }
  await expect(last).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-header-menu]')).toHaveCount(0)
  await expect(page).toHaveURL(before)
  expect(await focusSignature(page), 'Forward Tab must escape to the normal document successor, not wrap/trap')
    .toEqual(successor)
}

function notificationState(snapshot: Partial<Tables>, recipient: Account) {
  return {
    notifications: (snapshot.notifications ?? []).filter(row => row.recipient_id === recipient.profileId)
      .map(row => ({ id: row.id, isRead: row.is_read })),
    // The sender's thread has legitimate automatic read activity. Observe the
    // header viewer's reads only, not another account's independently open UI.
    membershipReads: (snapshot.conversation_participants ?? []).filter(row => row.profile_id === recipient.profileId)
      .map(row => ({ conversationId: row.conversation_id, lastReadAt: row.last_read_at })),
  }
}

async function checkPanelGeometry(page: Page, menu: HeaderMenu, reduced: boolean, requireInternalScroll = false) {
  const content = panel(page, menu)
  await expect.poll(async () => content.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  const metrics = await content.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const root = document.documentElement
    const rootStyle = getComputedStyle(root)
    const bodyStyle = getComputedStyle(document.body)
    const controls = Array.from(element.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary',
    )).filter(control => !control.matches(':disabled') && control.getClientRects().length > 0)
    const alpha = style.backgroundColor.match(/\/\s*([\d.]+)\s*\)$/)?.[1] ??
      (style.backgroundColor.startsWith('rgba(') ? style.backgroundColor.split(',').at(-1)?.replace(')', '').trim() : '1')
    return {
      x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom,
      width: bounds.width, height: bounds.height, viewportWidth: root.clientWidth, viewportHeight: innerHeight,
      side: element.getAttribute('data-side'),
      pageFits: root.scrollWidth <= root.clientWidth + 1 && document.body.scrollWidth <= root.clientWidth + 1,
      maskedOverflow: [rootStyle, bodyStyle].some(computed => ['hidden', 'clip'].includes(computed.overflowX)),
      documentLocked: [rootStyle, bodyStyle].some(computed =>
        ['hidden', 'clip'].includes(computed.overflowY) || computed.position === 'fixed'),
      panelFits: element.scrollWidth <= element.clientWidth + 1,
      overflowY: style.overflowY,
      opaque: style.backgroundColor !== 'transparent' && Number(alpha) === 1,
      controls: controls.map(control => {
        const rect = control.getBoundingClientRect()
        const computed = getComputedStyle(control)
        return {
          width: rect.width, height: rect.height,
          animation: computed.animationName, transition: computed.transitionDuration,
        }
      }),
      animation: style.animationName,
      transition: style.transitionDuration,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      rootScrollBehavior: rootStyle.scrollBehavior,
    }
  })
  const controlBounds = await trigger(page, menu).boundingBox()
  expect(controlBounds).not.toBeNull()
  expect(controlBounds!.width).toBeGreaterThanOrEqual(43.5)
  expect(controlBounds!.height).toBeGreaterThanOrEqual(43.5)
  expect(metrics.width).toBeGreaterThan(0)
  expect(metrics.height).toBeGreaterThan(0)
  expect(metrics.x).toBeGreaterThanOrEqual(0)
  expect(metrics.y).toBeGreaterThanOrEqual(0)
  // Radix may legitimately flip an anchored panel above its trigger.
  // It must still remain attached to that trigger and inside the viewport.
  expect(['bottom', 'top']).toContain(metrics.side)
  if (metrics.side === 'bottom') {
    expect(metrics.y).toBeGreaterThanOrEqual(controlBounds!.y + controlBounds!.height - 1)
    expect(metrics.y - controlBounds!.y - controlBounds!.height).toBeLessThanOrEqual(12)
  } else {
    expect(metrics.bottom).toBeLessThanOrEqual(controlBounds!.y + 1)
    expect(controlBounds!.y - metrics.bottom).toBeLessThanOrEqual(12)
  }
  expect(metrics.x).toBeLessThan(controlBounds!.x + controlBounds!.width)
  expect(metrics.right).toBeGreaterThan(controlBounds!.x)
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1)
  expect(metrics.pageFits).toBe(true)
  expect(metrics.maskedOverflow, 'Reflow must not be faked with document overflow-x masking').toBe(false)
  expect(metrics.documentLocked, 'An anchored nonmodal panel must not lock document scrolling').toBe(false)
  expect(metrics.panelFits).toBe(true)
  expect(metrics.opaque).toBe(true)
  expect(metrics.controls.length).toBeGreaterThan(0)
  expect(metrics.controls.every(control => control.width >= 43.5 && control.height >= 43.5),
    'Panel controls need real 44px hit areas, not merely large icons').toBe(true)
  if (reduced) {
    expect(metrics.reducedMotion).toBe(true)
    expect(metrics.rootScrollBehavior).toBe('auto')
    expect(metrics.animation).toBe('none')
    expect(metrics.transition.split(',').every(value => Number.parseFloat(value) === 0)).toBe(true)
    expect(metrics.controls.every(control => control.animation === 'none' &&
      control.transition.split(',').every(value => Number.parseFloat(value) === 0))).toBe(true)
    const triggerMotion = await trigger(page, menu).evaluate(element => {
      const style = getComputedStyle(element)
      return { animation: style.animationName, transition: style.transitionDuration }
    })
    expect(triggerMotion.animation).toBe('none')
    expect(triggerMotion.transition.split(',').every(value => Number.parseFloat(value) === 0)).toBe(true)
  }
  if (menu === 'campus') {
    const signout = content.getByRole('button', { name: 'Sign out', exact: true })
    const windowScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
    if (requireInternalScroll) {
      // The installed panel itself, including its heading, is the scroller.
      expect(metrics.overflowY).toBe('auto')
      expect(await content.evaluate(element => element.scrollHeight > element.clientHeight + 1),
        'The deliberately short campus panel must exercise actual internal overflow').toBe(true)
      await content.evaluate(element => { element.scrollTop = 0 })
    }
    await signout.scrollIntoViewIfNeeded()
    const bounds = await signout.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(metrics.y)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(metrics.bottom + 1)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(metrics.viewportHeight + 1)
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY })),
      'Reaching the last campus control must scroll its panel, not the document').toEqual(windowScroll)
    if (requireInternalScroll) {
      expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    }
  }
}

async function metricLink(page: Page, label: string, href: string, count: number) {
  const identity = page.locator('#main .profile-identity')
  await expect(identity).toHaveCount(1)
  const link = identity.getByRole('link', { name: new RegExp(`\\b${label}\\b`) })
  await expect(link).toHaveCount(1)
  await expect(link).toHaveAttribute('href', href)
  await expect(link).toBeVisible()
  // Both common number/label orders are accepted; the count itself may not be
  // a raw counter, invented value or absent decoration.
  expect((await link.textContent())?.match(/\d+/g) ?? []).toEqual([String(count)])
  return link
}

async function graphRows(
  page: Page, pathname: string, regionName: string, expected: readonly Account[], omitted: readonly Account[],
) {
  await expect(page).toHaveURL(url => url.origin === origin &&
    url.pathname === pathname && !url.search && !url.hash)
  const main = page.locator('#main')
  const direction = pathname.endsWith('/followers') ? 'Followers' :
    pathname.endsWith('/following') ? 'Following' : 'Connections'
  await expect(main.getByRole('heading', { level: 1, name: direction, exact: true })).toBeVisible()
  const navigation = main.getByRole('navigation', { name: 'Relationship lists', exact: true })
  await expect(navigation.getByRole('link', { name: direction, exact: true })).toHaveAttribute('aria-current', 'page')
  if (pathname.startsWith('/u/')) {
    await expect(navigation.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0)
    await expect(main.getByRole('navigation', { name: 'Manage relationships', exact: true })).toHaveCount(0)
  }
  const region = main.getByRole('region', { name: regionName, exact: true })
  await expect(region).toHaveCount(1)
  await expect(region).toBeVisible()
  await expect(region.getByText(`${expected.length} visible ${direction === 'Following'
    ? 'profiles followed' : direction.toLowerCase()}`, { exact: true })).toBeVisible()
  // Unique semantic list scope prevents matching header/sidebar/account links.
  const list = region.locator('ul').filter({ has: page.locator('a[href^="/u/"]') })
  await expect(list).toHaveCount(1)
  await expect(list.locator(':scope > li')).toHaveCount(expected.length)
  for (const account of expected) {
    const row = list.locator(':scope > li').filter({
      has: page.getByRole('link', { name: account.displayName, exact: true }),
    })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('link', { name: account.displayName, exact: true })).toHaveAttribute('href', profilePath(account))
  }
  for (const account of omitted) {
    await expect(main.getByRole('link', { name: account.displayName, exact: true })).toHaveCount(0)
    await expect(main.locator(`a[href="${profilePath(account)}"]`)).toHaveCount(0)
  }
}

async function noSerializedPeers(response: Response, omitted: readonly Account[]) {
  const serialized = await documentText(response)
  for (const account of omitted) {
    for (const value of [account.displayName, account.handle, account.profileId]) {
      expect(serialized.includes(value), 'Filtered graph peers must be absent from HTML and embedded Flight, not hidden by CSS')
        .toBe(false)
    }
  }
}

function firstConnectionAward(snapshot: Partial<Tables>, account: Account) {
  const receipts = (snapshot.profile_achievements ?? []).filter(row =>
    row.profile_id === account.profileId && row.achievement_key === 'first_connection')
  expect(receipts).toHaveLength(1)
  const receipt = receipts[0]
  if (!receipt) throw new Error('The real accepted connection did not persist its automatic award.')
  expect(receipt).toMatchObject({ awarded_value: 1, is_pinned: false })
  expect(receipt.id).toMatch(/^ach_[a-z0-9]+$/)
  return receipt
}

async function noPrivateConnectionEvidence(
  response: Response, foreignConnectionId: string, foreignAwardId: string, foreignProfile = false,
) {
  const serialized = await documentText(response)
  for (const value of [foreignConnectionId, foreignAwardId, 'first_connection']) {
    expect(serialized.includes(value),
      'A graph/profile document must not serialize an unrelated private edge or automatic connection award').toBe(false)
  }
  if (foreignProfile) {
    // Omitted/null DTO counters are legitimate; any numeric foreign connection
    // aggregate is not. Account-header links to the reader's own list are allowed.
    expect(/\\*"connection_count\\*"\s*:\s*-?\d/.test(serialized),
      'A foreign profile must not serialize a numeric connection counter').toBe(false)
  }
}

async function noForeignConnectionMetric(page: Page) {
  const identity = page.locator('#main .profile-identity')
  await expect(identity).toHaveCount(1)
  await expect(identity.getByText('Connections', { exact: true })).toHaveCount(0)
  await expect(identity.getByRole('link', { name: /\bConnections\b/ })).toHaveCount(0)
  await expect(page.locator('#main').getByText('First Connection', { exact: true })).toHaveCount(0)
}

async function localContext(browser: Browser) {
  const context = await browser.newContext({
    baseURL: origin, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block',
    viewport: { width: 1440, height: 960 }, colorScheme: 'light', reducedMotion: 'no-preference',
  })
  await onlyLocalNetwork(context)
  expect((await context.cookies()).some(cookie => cookie.name === cookieName)).toBe(false)
  return context
}

test('real header menus and privacy-safe owner/public graph navigation preserve consent and durable outcomes', async ({ page, browser }, info) => {
  // Retain the inherited bounded journey budget; no config/action timeout changes.
  test.setTimeout(360_000)
  const contexts: BrowserContext[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const extraPage = async () => {
    const context = await localContext(browser)
    contexts.push(context)
    const extra = await context.newPage()
    extra.on('pageerror', error => errors.push(error.message))
    return extra
  }
  try {
    const bobPage = await extraPage()
    const caseyPage = await extraPage()
    const danaPage = await extraPage()
    const observer = await extraPage()
    const suffix = randomBytes(4).toString('hex')
    let alice: Account
    let bob: Account
    let casey: Account
    let dana: Account
    await test.step('real signup stays private before onboarding; publication is explicit and Casey keeps the default', async () => {
      alice = await signup(page, observer, `hg_a_${suffix}`, `Header Alice ${suffix}`, 'public')
      bob = await signup(bobPage, observer, `hg_b_${suffix}`, `Header Bob ${suffix}`, 'public')
      casey = await signup(caseyPage, observer, `hg_c_${suffix}`, `Header Private Casey ${suffix}`, 'private')
      dana = await signup(danaPage, observer, `hg_d_${suffix}`, `Header Blocked Dana ${suffix}`, 'public')
    })
    // Every next step consumes the successful real setup above; no skip/fallback.
    const a = alice!
    const b = bob!
    const c = casey!
    const d = dana!
    let foreignConnectionId: string
    await test.step('UI-created edges exist before privacy filtering; pending requests are not accepted connections', async () => {
      await setVisibility(caseyPage, c, 'public')
      for (const [fromPage, from, to] of [
        [page, a, b], [bobPage, b, a],
        [caseyPage, c, b], [bobPage, b, c],
        [danaPage, d, b], [bobPage, b, d],
      ] as const) await follow(fromPage, from, to)
      await connect(page, bobPage, a, b, true)
      foreignConnectionId = await connect(bobPage, danaPage, b, d)
      await setVisibility(caseyPage, c, 'private')
      await block(page, a, d)
      const snapshot = await readFixture()
      expect(snapshot.follows).toHaveLength(6)
      expect(snapshot.connections).toHaveLength(2)
      expect(connection(snapshot, b, d).map(row => row.status)).toEqual(['accepted'])
      // Bob's Casey/Dana edges remain persisted. Omissions must be access
      // filtering, not absent setup rows or Alice deleting unrelated pairs.
      for (const peer of [c, d]) {
        expect(follows(snapshot, b, peer)).toHaveLength(1)
        expect(follows(snapshot, peer, b)).toHaveLength(1)
      }
    })
    const foreignAward = firstConnectionAward(await readFixture(), b)
    await test.step('the connection award is earned and remains readable by its owner', async () => {
      await visit(bobPage, '/goals', 'Goals')
      const awards = bobPage.locator('#main section').filter({
        has: bobPage.getByRole('heading', { level: 2, name: 'Achievements', exact: true }),
      })
      await expect(awards).toHaveCount(1)
      const held = awards.getByRole('listitem').filter({
        has: bobPage.getByText('First Connection', { exact: true }),
      })
      await expect(held).toHaveCount(1)
      await expect(held).toContainText('counted 1')
      await expect(held.getByText('Accepted 1 connection.', { exact: true })).toBeVisible()
      await bobPage.reload({ waitUntil: 'domcontentloaded' })
      await expect(held).toBeVisible()
      expect(firstConnectionAward(await readFixture(), b)).toEqual(foreignAward)
    })
    const activity = await sendRealNotification(bobPage, b, a, suffix)
    // Dana's separate legitimate notification supplies a valid foreign ID for
    // recipient-refusal coverage. She never opens that conversation or marks it.
    const foreignActivity = await sendRealNotification(bobPage, b, d, `${suffix}-foreign`)
    const headerDocument = await visit(page, '/me', a.displayName)
    const serializedHeader = await documentText(headerDocument)
    for (const withheld of [activity.body, foreignActivity.id, foreignActivity.conversationId, foreignActivity.body]) {
      expect(serializedHeader.includes(withheld),
        'The server-prepared header must serialize neither message bodies nor another recipient activity').toBe(false)
    }

    await test.step('first profile, bell and hamburger clicks do not navigate/post; one anchored nonmodal panel is open', async () => {
      const before = notificationState(await readFixture(), a)
      await expect(trigger(page, 'notifications')).toHaveAttribute('aria-label', 'Notifications, 1 unread')
      await withoutPost(page, async () => {
        for (const menu of ['profile', 'notifications', 'campus'] as const) {
          await openMenu(page, menu)
          if (menu === 'notifications') {
            const recent = panel(page, menu).getByRole('list', { name: 'Recent notifications', exact: true })
            await expect(recent.locator(':scope > li')).toHaveCount(1)
            expect(await recent.locator(':scope > li').count()).toBeLessThanOrEqual(5)
            await expect(recent).toContainText(`${b.displayName} sent you a message.`)
            await expect(recent).not.toContainText(activity.body)
            await expect(recent.getByRole('link', { name: 'Open the conversation', exact: true }))
              .toHaveAttribute('href', `/messages?c=${activity.conversationId}`)
          }
          await escapeMenu(page, menu)
        }
        await openMenu(page, 'profile')
        await openMenu(page, 'notifications') // Switching uses the real second trigger.
        await expect(trigger(page, 'profile')).toHaveAttribute('aria-expanded', 'false')
        await openMenu(page, 'campus')
        await expect(trigger(page, 'notifications')).toHaveAttribute('aria-expanded', 'false')
        await escapeMenu(page, 'campus')
      })
      expect(notificationState(await readFixture(), a)).toEqual(before)
    })

    await test.step('Escape, explicit close, outside pointer/focus and native Tab edges do not trap or mutate', async () => {
      const before = notificationState(await readFixture(), a)
      await withoutPost(page, async () => {
        for (const menu of ['profile', 'notifications', 'campus'] as const) {
          const beforeUrl = page.url()
          const content = await openMenu(page, menu)
          await content.getByLabel('Close', { exact: true }).click()
          await expect(page.locator('[data-header-menu]')).toHaveCount(0)
          await expect(trigger(page, menu)).toBeFocused()
          await openMenu(page, menu)
          const outside = header(page).getByRole('searchbox', { name: 'Search Bulla', exact: true })
          await expect(outside).toBeVisible()
          await outside.click()
          await expect(page.locator('[data-header-menu]')).toHaveCount(0)
          await expect(outside).toBeFocused() // Nonmodal dismissal preserves the outside destination.
          await expect(page).toHaveURL(beforeUrl)
          await openMenu(page, menu)
          await outside.focus()
          await expect(page.locator('[data-header-menu]')).toHaveCount(0)
          await expect(outside).toBeFocused()
          await expect(page).toHaveURL(beforeUrl)
          await keyboardEdges(page, menu)
        }
      })
      expect(notificationState(await readFixture(), a)).toEqual(before)
    })

    await test.step('real appearance controls, mobile reflow, opaque bounds and reduced motion work without read mutations', async () => {
      const before = notificationState(await readFixture(), a)
      for (const view of [
        { width: 1440, height: 960, theme: 'light', motion: 'no-preference' },
        { width: 320, height: 480, theme: 'light', motion: 'reduce' },
        { width: 320, height: 360, theme: 'dark', motion: 'reduce' },
      ] as const) {
        await page.setViewportSize({ width: view.width, height: view.height })
        await page.emulateMedia({ colorScheme: view.theme, reducedMotion: view.motion })
        await withoutPost(page, async () => {
          const campus = await openMenu(page, 'campus')
          const choice = campus.getByRole('group', { name: 'Theme', exact: true })
            .getByRole('button', { name: view.theme === 'dark' ? 'Dark' : 'Light', exact: true })
          await choice.click()
          await expect(choice).toHaveAttribute('aria-pressed', 'true')
          await expect(campus).toBeVisible()
          await expect(page.locator('html')).toHaveClass(view.theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
          await escapeMenu(page, 'campus')
          for (const menu of ['profile', 'notifications', 'campus'] as const) {
            await openMenu(page, menu)
            await checkPanelGeometry(page, menu, view.motion === 'reduce', view.width === 320)
            // Only this run's synthetic signed-in UI, never signup credentials,
            // owner data or session-bearing traces. Evidence remains private.
            await panel(page, menu).evaluate(element => { element.scrollTop = 0 })
            await page.screenshot({
              path: info.outputPath(`header-${menu}-${view.theme}-${view.width}x${view.height}.png`),
              fullPage: false, animations: 'disabled',
            })
            await escapeMenu(page, menu)
          }
          if (view.width === 320) {
            for (const menu of ['profile', 'notifications', 'campus'] as const) {
              await keyboardEdges(page, menu)
            }
          }
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('html')).toHaveClass(view.theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
      }
      expect(notificationState(await readFixture(), a)).toEqual(before)
    })

    await test.step('a real read form cannot mark a different recipient; its legitimate read stays open and persists', async () => {
      const beforeUrl = page.url()
      const content = await openMenu(page, 'notifications')
      const row = content.getByRole('list', { name: 'Recent notifications', exact: true }).locator(':scope > li').filter({
        has: page.locator(`input[name="id"][value="${activity.id}"]`),
      })
      await expect(row).toHaveCount(1)
      const idField = row.locator('form input[name="id"]')
      await expect(idField).toHaveCount(1)
      await expect(idField).toHaveValue(activity.id)
      const ownBefore = notificationState(await readFixture(), a)
      const foreignBefore = notificationState(await readFixture(), d)
      // Change only the submitted DOM field, never the fixture or session.
      // The real recipient guard treats a valid foreign ID as an unchanged row,
      // not a fabricated loud error or successful read.
      await idField.evaluate((element, id) => {
        if (!(element instanceof HTMLInputElement)) throw new Error('Expected the real notification ID form field.')
        element.value = id
      }, foreignActivity.id)
      await expect(idField).toHaveValue(foreignActivity.id)
      const refused = await submit(page, row.getByRole('button', { name: 'Mark as read', exact: true }), async () => {
        expect(notificationState(await readFixture(), a)).toEqual(ownBefore)
        expect(notificationState(await readFixture(), d)).toEqual(foreignBefore)
        await expect(content).toBeVisible()
        await expect(row.getByRole('button', { name: 'Mark as read', exact: true })).toBeEnabled()
        await expect(trigger(page, 'notifications')).toHaveAttribute('aria-label', 'Notifications, 1 unread')
        await expect(page).toHaveURL(beforeUrl)
      })
      expect(refused.request().postData()?.includes(foreignActivity.id),
        'The refused real action must actually carry the other recipient notification ID').toBe(true)
      await idField.evaluate((element, id) => {
        if (!(element instanceof HTMLInputElement)) throw new Error('Expected the unchanged notification ID form field.')
        element.value = id
      }, activity.id)
      await expect(idField).toHaveValue(activity.id)
      await submit(page, row.getByRole('button', { name: 'Mark as read', exact: true }), async () => {
        await expect.poll(async () => (await readFixture()).notifications?.find(item => item.id === activity.id)?.is_read)
          .toBe(true)
        await expect(content).toBeVisible()
        await expect(content.getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(0)
        await expect(trigger(page, 'notifications')).toHaveAttribute('aria-expanded', 'true')
        await expect(trigger(page, 'notifications')).toHaveAttribute('aria-label', 'Notifications')
        await expect(page).toHaveURL(beforeUrl)
      })
      expect(notificationState(await readFixture(), a).membershipReads).toEqual(ownBefore.membershipReads)
      expect(notificationState(await readFixture(), d)).toEqual(foreignBefore)
      const survivingTarget = content.getByRole('link', { name: 'Open the conversation', exact: true })
      await expect(survivingTarget).toHaveCount(1)
      await expect(survivingTarget).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(content.getByRole('link', { name: 'View all notifications', exact: true })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(survivingTarget).toBeFocused()
      await escapeMenu(page, 'notifications')
      await openMenu(page, 'notifications')
      await content.getByRole('link', { name: 'View all notifications', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === '/notifications' && !url.search && !url.hash)
      await expect(page.locator('[data-header-menu]')).toHaveCount(0)
      await expect(page.locator('#main').getByRole('heading', { level: 1, name: 'Notifications', exact: true })).toBeVisible()
      await expect(page.locator('#main')).not.toContainText(activity.body)
      expect((await readFixture()).notifications?.filter(item => item.recipient_id === a.profileId).map(item => item.is_read))
        .toEqual([true])
    })

    await test.step('all six account links and a real campus link navigate inside the app', async () => {
      for (const [label, pathname] of profileDestinations) {
        await visit(page, '/me', a.displayName)
        const content = await openMenu(page, 'profile')
        const link = content.getByRole('navigation', { name: 'Your account', exact: true })
          .getByRole('link', { name: label, exact: true })
        await expect(link).toHaveAttribute('href', pathname)
        await link.click()
        await expect(page).toHaveURL(url => url.origin === origin && url.pathname === pathname && !url.search && !url.hash)
        await expect(page.locator('[data-header-menu]')).toHaveCount(0)
        if (pathname.startsWith('/connections')) {
          const region = pathname === '/connections' ? graphRegions.own.connections :
            pathname.endsWith('/followers') ? graphRegions.own.followers : graphRegions.own.following
          await graphRows(page, pathname, region, [b], [c, d, a])
        } else {
          await expect(page.locator('#main').getByRole('heading', { level: 1 })).toHaveCount(1)
        }
      }
      const content = await openMenu(page, 'campus')
      const feed = content.getByRole('navigation', { name: 'Campus workspace', exact: true })
        .getByRole('link', { name: 'Feed', exact: true })
      await expect(feed).toHaveAttribute('href', '/feed')
      await feed.click()
      await expect(page).toHaveURL(url => url.pathname === '/feed' && !url.search && !url.hash)
      await expect(page.locator('#main').getByRole('heading', { level: 1, name: 'Campus feed', exact: true })).toBeVisible()
      await expect(page.locator('[data-header-menu]')).toHaveCount(0)
    })

    await test.step('own profile metric clicks reach separate durable lists; no pending/foreign connection appears', async () => {
      for (const [label, pathname, region] of [
        ['Followers', '/connections/followers', graphRegions.own.followers],
        ['Following', '/connections/following', graphRegions.own.following],
        ['Connections', '/connections', graphRegions.own.connections],
      ] as const) {
        await visit(page, '/me', a.displayName)
        await (await metricLink(page, label, pathname, 1)).click()
        await graphRows(page, pathname, region, [b], [c, d, a])
        const document = await page.reload({ waitUntil: 'domcontentloaded' })
        expect(document?.status()).toBe(200)
        await graphRows(page, pathname, region, [b], [c, d, a])
        await noPrivateConnectionEvidence(document!, foreignConnectionId!, foreignAward.id)
      }
      expect(connection(await readFixture(), b, d).map(row => row.id)).toEqual([foreignConnectionId!])
    })

    await test.step('public-subject lists use viewer-safe peers/counts and serialize neither private nor blocked rows', async () => {
      // Bob has THREE persisted follows in each direction, but Alice may see
      // only Alice: private Casey and Alice-blocked Dana must not be counted.
      for (const direction of ['followers', 'following'] as const satisfies readonly Direction[]) {
        const pathname = `${profilePath(b)}/${direction}`
        const profileDocument = await visit(page, profilePath(b), b.displayName)
        await noForeignConnectionMetric(page)
        await noPrivateConnectionEvidence(profileDocument, foreignConnectionId!, foreignAward.id, true)
        await (await metricLink(page, direction === 'followers' ? 'Followers' : 'Following', pathname, 1)).click()
        await graphRows(page, pathname, graphRegions.public[direction], [a], [c, d])
        const response = await page.reload({ waitUntil: 'domcontentloaded' })
        expect(response?.status()).toBe(200)
        await graphRows(page, pathname, graphRegions.public[direction], [a], [c, d])
        await noSerializedPeers(response!, [c, d])
        await noPrivateConnectionEvidence(response!, foreignConnectionId!, foreignAward.id, true)

        // Anonymous public reads have no Alice/Dana block relation: Alice and
        // public Dana remain eligible; Casey stays private. This also proves
        // Alice's block did not destroy Bob/Dana's unrelated real edges.
        const anonymousProfile = await visit(observer, profilePath(b), b.displayName)
        await noForeignConnectionMetric(observer)
        await noPrivateConnectionEvidence(anonymousProfile, foreignConnectionId!, foreignAward.id, true)
        await (await metricLink(observer, direction === 'followers' ? 'Followers' : 'Following', pathname, 2)).click()
        await graphRows(observer, pathname, graphRegions.public[direction], [a, d], [c])
        const publicResponse = await observer.reload({ waitUntil: 'domcontentloaded' })
        expect(publicResponse?.status()).toBe(200)
        await graphRows(observer, pathname, graphRegions.public[direction], [a, d], [c])
        await noSerializedPeers(publicResponse!, [c])
        await noPrivateConnectionEvidence(publicResponse!, foreignConnectionId!, foreignAward.id, true)
      }
      for (const direction of ['followers', 'following'] as const) {
        await unavailable(page, `${profilePath(c)}/${direction}`, [c.displayName, c.profileId])
        await unavailable(observer, `${profilePath(c)}/${direction}`, [c.displayName, c.profileId])
        await unavailable(page, `${profilePath(d)}/${direction}`, [d.displayName, d.profileId])
      }
      await unavailable(page, `${profilePath(b)}/connections`, [b.displayName, foreignConnectionId!, d.profileId])
      await unavailable(observer, `${profilePath(b)}/connections`, [b.displayName, foreignConnectionId!, d.profileId])
      const snapshot = await readFixture()
      expect(snapshot.follows).toHaveLength(6)
      expect(connection(snapshot, b, d).map(row => row.status)).toEqual(['accepted'])
      expect(snapshot.profiles?.find(row => row.id === c.profileId)?.visibility).toBe('private')
      expect(firstConnectionAward(snapshot, b)).toEqual(foreignAward)
    })

    await test.step('real menu signout revokes its opaque cookie; stale-cookie replay cannot reopen owner graph pages', async () => {
      await visit(page, '/me', a.displayName)
      const cookie = (await page.context().cookies()).find(row => row.name === cookieName)
      expect(Boolean(cookie && cookie.httpOnly)).toBe(true)
      const digest = createHash('sha256').update(cookie!.value).digest('hex')
      expect((await readFixture()).sessions?.some(row => row.user_id === a.userId && row.token_hash === digest)).toBe(true)
      const content = await openMenu(page, 'campus')
      await submit(page, content.getByRole('button', { name: 'Sign out', exact: true }), async () => {
        await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/' && !url.search && !url.hash)
        await expect(header(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
        expect((await page.context().cookies()).some(row => row.name === cookieName)).toBe(false)
        await expect.poll(async () => (await readFixture()).sessions?.some(row =>
          row.user_id === a.userId && row.token_hash === digest)).toBe(false)
      })
      const afterSignout = await readFixture()
      const replay = await extraPage()
      // The ONLY cookie injection in this spec is a legitimately captured,
      // already-revoked cookie, exclusively for negative authorization checks.
      await replay.context().addCookies([cookie!])
      expect((await replay.context().cookies()).some(row => row.name === cookieName)).toBe(true)
      for (const pathname of ['/me', '/connections/followers', '/connections/following', '/connections']) {
        await replay.goto(pathname, { waitUntil: 'domcontentloaded' })
        await expect(replay).toHaveURL(url => url.origin === origin && url.pathname === '/login' &&
          url.searchParams.get('next') === pathname)
        await expect(replay.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
        await expect(header(replay).getByRole('button', { name: 'Your profile', exact: true })).toHaveCount(0)
        await expect(replay.locator('#main').getByRole('link', { name: b.displayName, exact: true })).toHaveCount(0)
      }
      const afterDenial = await readFixture()
      // Do not dump users/session hashes/credentials to assertion artifacts.
      for (const table of ['follows', 'connections', 'blocks', 'messages', 'notifications', 'profile_achievements'] as const) {
        expect(JSON.stringify(afterDenial[table]) === JSON.stringify(afterSignout[table]),
          'Refused stale-session reads must not change durable domain state').toBe(true)
      }
      expect(afterDenial.sessions?.some(row => row.token_hash === digest)).toBe(false)
      expect((afterDenial.users ?? []).length).toBe(4)
      expect((afterDenial.profiles ?? []).length).toBe(4)
      expect(afterDenial.users?.every(row => knownUsers.has(row.id))).toBe(true)
    })
    expect(errors, 'No browser page exception may be ignored as a successful journey').toEqual([])
  } finally {
    for (const context of contexts) await context.close()
    // Keep fixture/evidence/marker intact. Only main may coordinate a NEW run.
  }
})
