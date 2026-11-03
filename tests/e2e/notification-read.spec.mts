import {
  test, expect, type BrowserContext, type Locator, type Page, type Response, type TestInfo,
} from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { validateArtifactRoot } from '../../scripts/bulla/browser-acceptance.mjs'
import { completeAction } from './helpers/complete-action'
import { hasNoStoreCachePolicy } from './helpers/no-store-cache'
import type { LocalNotification, Tables } from '../../src/lib/local/db'

/**
 * Explicit ESM is required for the real runner's .mjs safety helper. The
 * Playwright CommonJS test loader cannot execute that helper's import.meta.
 *
 * Real single-read/native-bulk acceptance through the existing isolated runner.
 * Exactly two UI-created accounts, explicit publication, connect/accept, a DM
 * and two small groups. Notifications come only from accepted real sends.
 * No seed, fixture repair, budget reset, response stubbing or guessed action ID.
 * Only Alice's own verified synthetic cookie is copied to her no-JS context.
 * Local UI evidence is not hosted/provider/error/retry/load acceptance.
 */
const cookieName = 'quad_local_session'
const actionBudget = 20_000
const maxFixtureBytes = 5 * 1024 * 1024
const maxDocumentBytes = 2 * 1024 * 1024
const maxActionBytes = 64 * 1024
const requiredTables = [
  'users', 'sessions', 'profiles', 'connections', 'conversations',
  'conversation_participants', 'messages', 'notifications',
] as const
type Account = { userId: string; profileId: string; handle: string; displayName: string }
type Activity = { id: string; conversationId: string; actorName: string; body: string }
let origin: string
let ownedArtifactRoot: string
let runRoot: string
let fixtureRoot: string
let fixtureFile: string

test.use({
  storageState: { cookies: [], origins: [] }, serviceWorkers: 'block',
  trace: 'off', video: 'off', screenshot: 'off',
  viewport: { width: 1440, height: 960 }, colorScheme: 'light',
})

function inside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Notification acceptance requires a contained task-owned path.')
  }
}

function samePath(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function localOrigin(baseURL: string | undefined) {
  if (!baseURL) throw new Error('A dedicated loopback baseURL is required.')
  const url = new URL(baseURL)
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000 ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER !== '0') {
    throw new Error('Use the existing fresh IPv4 loopback runner, never an owner or reused server.')
  }
  return url.origin
}

async function ordinaryDirectory(directory: string) {
  inside(ownedArtifactRoot, directory)
  const entry = await fs.lstat(directory)
  const real = await fs.realpath(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(directory, real)) {
    throw new Error('Refusing a linked or replaced acceptance directory.')
  }
  inside(await fs.realpath(ownedArtifactRoot), real)
}

function missingOnly(error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  return null
}

async function readFixture(): Promise<Tables> {
  await ordinaryDirectory(runRoot)
  await ordinaryDirectory(fixtureRoot)
  inside(await fs.realpath(runRoot), await fs.realpath(fixtureRoot))
  inside(fixtureRoot, fixtureFile)
  const entry = await fs.lstat(fixtureFile)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > maxFixtureBytes) {
    throw new Error('Refusing a missing, replaced or oversized synthetic fixture.')
  }
  inside(await fs.realpath(fixtureRoot), await fs.realpath(fixtureFile))
  const bytes = await fs.readFile(fixtureFile)
  if (bytes.length > maxFixtureBytes) throw new Error('Synthetic fixture exceeds the read bound.')
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('Synthetic fixture JSON is invalid; never print or repair it.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some(rows => !Array.isArray(rows)) ||
    requiredTables.some(name => !Object.hasOwn(parsed, name))) {
    throw new Error('Synthetic fixture must contain the actual required array tables.')
  }
  const snapshot = parsed as Tables
  if (snapshot.notifications.some(row => !row || !/^ntf_[a-z0-9]+$/.test(row.id) ||
    typeof row.recipient_id !== 'string' || typeof row.is_read !== 'boolean')) {
    throw new Error('Notification receipts must contain real IDs, recipients and boolean flags.')
  }
  return snapshot
}

test.beforeAll(async ({ browserName, channel }, info) => {
  const requested = process.env.BULLA_E2E_BROWSER ?? ''
  const root = process.env.BULLA_E2E_ARTIFACT_DIR
  const run = process.env.BULLA_E2E_RUN_ID
  if (browserName !== 'chromium' ||
    !['', 'chrome', 'msedge', 'chromium'].includes(requested) || (channel ?? '') !== requested ||
    !root || !path.isAbsolute(root) || path.basename(root) !== 'specs' ||
    !run || !/^spec-\d{2}-notification-read-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run) ||
    info.config.workers !== 1 || info.config.projects.length !== 1 || info.config.fullyParallel ||
    info.project.retries !== 0 || info.project.repeatEach !== 1) {
    throw new Error('Select only notification-read through the existing per-spec runner.')
  }
  // Reuse the runner's Windows D-drive / dedicated Linux CI artifact fence.
  // This validates the grandparent, not an arbitrary supplied fixture root.
  ownedArtifactRoot = validateArtifactRoot(path.dirname(path.dirname(root)))
  origin = localOrigin(process.env.BULLA_E2E_BASE_URL)
  runRoot = path.resolve(root, run)
  fixtureRoot = path.join(runRoot, 'fixture')
  fixtureFile = path.join(fixtureRoot, 'local.json')
  inside(root, runRoot)
  inside(runRoot, info.outputDir)
  const server = info.config.webServer
  const env = server?.env
  if (!server || server.reuseExistingServer !== false || !server.url ||
    localOrigin(server.url) !== origin || !env || env.NEXT_PUBLIC_DATA_MODE !== 'local' ||
    env.NEXT_PUBLIC_SITE_URL !== origin || env.NEXT_PUBLIC_SUPABASE_URL !== '' ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' || env.SUPABASE_SERVICE_ROLE_KEY !== '' ||
    !env.LOCAL_DATA_PATH || !samePath(env.LOCAL_DATA_PATH, fixtureFile) ||
    !env.BULLA_LOCAL_MEDIA_ROOT || !samePath(env.BULLA_LOCAL_MEDIA_ROOT, path.join(fixtureRoot, 'media')) ||
    process.env.NEXT_PUBLIC_DATA_MODE !== 'local' ||
    process.env.LOCAL_DATA_PATH === undefined || !samePath(process.env.LOCAL_DATA_PATH, fixtureFile) ||
    process.env.NEXT_PUBLIC_SUPABASE_URL !== '' || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' ||
    process.env.SUPABASE_SERVICE_ROLE_KEY !== '') {
    throw new Error('The resolved fresh webServer must isolate real local data/media and clear hosted keys.')
  }
  for (const directory of [root, runRoot, fixtureRoot, env.BULLA_LOCAL_MEDIA_ROOT]) {
    await ordinaryDirectory(directory)
  }
  if (await fs.lstat(`${fixtureFile}.lock`).catch(missingOnly)) {
    throw new Error('A fresh fixture may not have a lock; never remove one.')
  }
  if (await fs.lstat(fixtureFile).catch(missingOnly)) {
    const snapshot = await readFixture()
    if (Object.values(snapshot).some(rows => rows.length !== 0)) {
      throw new Error('An empty fixture is mandatory. Retain failures and use a NEW runner-generated directory.')
    }
  }
})

async function localNetwork(context: BrowserContext, violation: () => void) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['about:', 'data:', 'blob:'].includes(url.protocol)) {
      await route.continue()
    } else {
      violation()
      await route.abort('blockedbyclient')
    }
  })
  await context.routeWebSocket(url => {
    const local = new URL(origin)
    return url.protocol !== 'ws:' || url.hostname !== local.hostname || url.port !== local.port
  }, socket => {
    violation()
    socket.close({ code: 1008, reason: 'Loopback-only acceptance' })
  })
}

const main = (page: Page) => page.getByRole('main')
const bell = (page: Page) => page.locator('header.app-header').getByRole('button', {
  name: /^Notifications(?:, [1-9]\d* unread)?$/, exact: true,
})
const notificationRows = (page: Page) => main(page).getByRole('listitem').filter({
  has: page.locator('[data-notification-message]'),
})
const activityRow = (page: Page, activity: Activity) => notificationRows(page).filter({
  has: page.locator(`a[href="/messages?c=${activity.conversationId}"]`),
})
const thread = (page: Page) => main(page).locator('section[aria-labelledby="thread-heading"]')

async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const response = await completeAction(page, control, outcome, actionBudget)
  expect(response.status(), 'A real accepted action must return an accepted status').toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

async function visit(page: Page, href: string, heading?: string) {
  const response = await page.goto(href, { waitUntil: 'domcontentloaded' })
  expect(response?.status(), 'An ordinary document must actually return 200').toBe(200)
  await expect(page).toHaveURL(new URL(href, origin).href)
  if (heading) await expect(main(page).getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
  return response!
}

async function privateDocument(page: Page, response: Response | null, withheld: readonly string[]) {
  if (!response || response.status() !== 200 ||
    !/^text\/html(?:;|$)/i.test(response.headers()['content-type'] ?? '') ||
    !hasNoStoreCachePolicy(response.headers()['cache-control'])) {
    throw new Error('Privacy evidence requires the actual successful no-store HTML document.')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let text: string
  try {
    text = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The bounded privacy document did not finish.')), actionBudget)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
  const dom = await page.content()
  if (Buffer.byteLength(text) > maxDocumentBytes || Buffer.byteLength(dom) > maxDocumentBytes) {
    throw new Error('Privacy document exceeds the observation bound.')
  }
  for (const value of withheld) {
    expect(text.includes(value) || dom.includes(value),
      'Private message bodies and foreign notification IDs must not reach HTML/embedded Flight/DOM').toBe(false)
  }
}

async function sessionCookie(page: Page, account: Account) {
  const cookies = (await page.context().cookies(origin)).filter(row => row.name === cookieName)
  if (cookies.length !== 1 || !cookies[0].httpOnly || cookies[0].sameSite !== 'Lax' ||
    cookies[0].domain !== new URL(origin).hostname) {
    throw new Error('Expected only this synthetic account’s real opaque local session cookie.')
  }
  const cookie = cookies[0]
  const digest = createHash('sha256').update(cookie.value).digest('hex')
  const snapshot = await readFixture()
  expect(snapshot.profiles.some(row => row.id === account.profileId && row.user_id === account.userId &&
    row.username === account.handle), 'The synthetic session must belong to its UI-created profile').toBe(true)
  expect(snapshot.users.some(row => row.id === account.userId && row.email === `${account.handle}@example.test`)).toBe(true)
  expect(snapshot.sessions.some(row => row.user_id === account.userId && row.token_hash === digest &&
    Date.parse(row.expires_at) > Date.now()), 'The real session must be durable and unexpired').toBe(true)
  return cookie
}

async function signup(page: Page, handle: string, displayName: string): Promise<Account> {
  await visit(page, '/signup')
  await main(page).getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await main(page).getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(`${handle}@example.test`)
  try {
    await main(page).getByLabel(/^Password/).fill(`Notification-${randomBytes(18).toString('base64url')}-9Aa!`)
  } catch {
    throw new Error('The synthetic signup password field could not be filled.')
  }
  await main(page).getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, main(page).getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL(new URL('/onboarding', origin).href))
  await expect(main(page).getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await main(page).getByLabel(/^Choose a username/).fill(handle)
  await main(page).getByLabel(/^Who can see your profile/).selectOption('public')
  await submit(page, main(page).getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL(new URL('/me', origin).href)
    await expect(main(page).getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  })
  const profile = (await readFixture()).profiles.find(row => row.username === handle)
  if (!profile || profile.visibility !== 'public' || profile.onboarding_completed !== true) {
    throw new Error('Real public onboarding must persist before peer interactions.')
  }
  const account = { userId: profile.user_id, profileId: profile.id, handle, displayName }
  await sessionCookie(page, account)
  return account
}

async function connect(aPage: Page, bPage: Page, a: Account, b: Account) {
  const connection = async () => (await readFixture()).connections.filter(row =>
    row.requester_id === a.profileId && row.addressee_id === b.profileId)
  await visit(aPage, `/u/${b.handle}`, b.displayName)
  await submit(aPage, main(aPage).getByRole('button', { name: 'Connect', exact: true }), async () => {
    await expect(main(aPage).getByText('Request sent', { exact: true })).toBeVisible()
    await expect.poll(async () => (await connection()).map(row => row.status)).toEqual(['pending'])
  })
  await visit(bPage, `/u/${a.handle}`, a.displayName)
  await submit(bPage, main(bPage).getByRole('button', { name: /^Accept the connection request from/ }), async () => {
    await expect(main(bPage).getByText('Connected', { exact: true })).toBeVisible()
    await expect.poll(async () => (await connection()).map(row => row.status)).toEqual(['accepted'])
  })
  expect((await readFixture()).connections.length).toBe(1)
}

async function newMessage(page: Page) {
  await visit(page, '/messages', 'Messages')
  const disclosure = main(page).locator('aside details').filter({
    has: page.locator(':scope > summary').filter({ hasText: /^\s*New message\s*$/ }),
  })
  await expect(disclosure).toHaveCount(1)
  if (await disclosure.getAttribute('open') === null) {
    await disclosure.locator(':scope > summary').filter({ hasText: /^\s*New message\s*$/ }).click()
  }
  return disclosure
}

async function directConversation(page: Page, recipient: Account) {
  const disclosure = await newMessage(page)
  await disclosure.getByRole('textbox', { name: /^Their handle/ }).fill(recipient.handle)
  await submit(page, disclosure.getByRole('button', { name: 'Start conversation', exact: true }), async () => {
    await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/messages' &&
      /^cnv_[a-z0-9]+$/.test(url.searchParams.get('c') ?? ''))
    await expect(thread(page).getByRole('heading', { level: 2, name: recipient.displayName, exact: true })).toBeVisible()
  })
  const id = new URL(page.url()).searchParams.get('c')!
  expect((await readFixture()).conversations.some(row => row.id === id && row.type === 'direct')).toBe(true)
  return id
}

async function groupConversation(page: Page, sender: Account, recipient: Account, title: string) {
  const disclosure = await newMessage(page)
  const group = disclosure.locator('details').filter({
    has: page.locator(':scope > summary').filter({ hasText: /^\s*Create group\s*$/ }),
  })
  await expect(group).toHaveCount(1)
  await group.locator(':scope > summary').filter({ hasText: /^\s*Create group\s*$/ }).click()
  await group.getByRole('textbox', { name: /^Group name/ }).fill(title)
  await group.getByRole('textbox', { name: /^Group handles/ }).fill(recipient.handle)
  await submit(page, group.getByRole('button', { name: 'Create group', exact: true }), async () => {
    await expect(group.getByRole('status')).toHaveText('Group created. 1 person added.')
    await expect(group.getByRole('link', { name: 'Open group', exact: true })).toBeVisible()
  })
  await group.getByRole('link', { name: 'Open group', exact: true }).click()
  await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/messages' &&
    /^cnv_[a-z0-9]+$/.test(url.searchParams.get('c') ?? ''))
  await expect(thread(page).getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible()
  const id = new URL(page.url()).searchParams.get('c')!
  const snapshot = await readFixture()
  expect(snapshot.conversations.filter(row => row.id === id && row.type === 'group' && row.title === title).length).toBe(1)
  const members = snapshot.conversation_participants.filter(row => row.conversation_id === id)
  expect(members.length).toBe(2)
  expect(members.some(row => row.profile_id === sender.profileId && row.role === 'admin')).toBe(true)
  expect(members.some(row => row.profile_id === recipient.profileId && row.role === 'member')).toBe(true)
  return id
}

async function send(page: Page, sender: Account, recipient: Account, conversationId: string, body: string): Promise<Activity> {
  const composer = thread(page).locator('form').filter({ has: page.locator('textarea[name="body"]') })
  await expect(composer).toHaveCount(1)
  await expect(composer.locator('input[name="conversationId"]')).toHaveValue(conversationId)
  const input = composer.getByRole('textbox', { name: 'Message', exact: true })
  await expect(input).toBeEnabled()
  await expect(composer.getByRole('status').filter({ hasText: 'Loading your draft…' })).toHaveCount(0)
  await expect(input).toHaveValue('')
  await input.fill(body)
  await expect(input).toHaveValue(body)
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await submit(page, composer.getByRole('button', { name: 'Send', exact: true }), async () => {
    await expect(input).toHaveValue('')
    await expect(thread(page).getByText(body, { exact: true })).toHaveCount(1)
    await expect.poll(async () => (await readFixture()).messages.filter(row =>
      row.conversation_id === conversationId && row.author_id === sender.profileId && row.body === body).length).toBe(1)
    await expect.poll(async () => (await readFixture()).notifications.filter(row =>
      row.recipient_id === recipient.profileId && row.actor_id === sender.profileId &&
      row.type === 'message' && row.conversation_id === conversationId && row.is_read === false).length).toBe(1)
  })
  const notices = (await readFixture()).notifications.filter(row =>
    row.recipient_id === recipient.profileId && row.actor_id === sender.profileId &&
    row.type === 'message' && row.conversation_id === conversationId)
  if (notices.length !== 1 || notices[0].body !== null || notices[0].is_read !== false) {
    throw new Error('The accepted real send must emit one bodyless recipient-owned unread notification.')
  }
  return { id: notices[0].id, conversationId, actorName: sender.displayName, body }
}

async function badge(page: Page, count: number) {
  const control = bell(page)
  await expect(control).toHaveCount(1)
  await expect(control).toBeVisible()
  await expect(control).toHaveAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications')
  const numeric = control.locator('span[aria-hidden="true"]').filter({ hasText: /^(?:[1-9]\d*|99\+)$/ })
  await expect(numeric).toHaveCount(count ? 1 : 0)
  if (count) {
    await expect(numeric).toBeVisible()
    await expect(numeric).toHaveText(String(count))
  }
}

async function fullList(page: Page, activities: readonly Activity[], readIds: readonly string[]) {
  await expect(page).toHaveURL(new URL('/notifications', origin).href)
  await expect(main(page).getByRole('heading', { level: 1, name: 'Notifications', exact: true })).toBeVisible()
  await expect(notificationRows(page)).toHaveCount(activities.length)
  const unread = activities.filter(row => !readIds.includes(row.id)).length
  const countCopy = unread === 0 ? 'Nothing unread.' : unread === 1 ? 'One unread.' : `${unread} unread.`
  await expect(main(page).getByText(countCopy, { exact: true })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(unread)
  await expect(main(page).getByRole('alert')).toHaveCount(0)
  for (const activity of activities) {
    const row = activityRow(page, activity)
    await expect(row).toHaveCount(1)
    await expect(row.locator('[data-notification-message]')).toHaveText(
      `${readIds.includes(activity.id) ? '' : 'Unread. '}${activity.actorName} sent you a message.`,
    )
    await expect(row.getByRole('link', { name: 'Open the conversation', exact: true }))
      .toHaveAttribute('href', `/messages?c=${activity.conversationId}`)
    await expect(row.getByRole('button', { name: 'Mark as read', exact: true }))
      .toHaveCount(readIds.includes(activity.id) ? 0 : 1)
  }
  await badge(page, unread)
}

function markedRows(rows: readonly LocalNotification[], ids: readonly string[]) {
  return rows.map(row => ({ ...row, is_read: row.is_read || ids.includes(row.id) }))
}

async function exactRows(expected: readonly LocalNotification[]) {
  await expect.poll(async () => JSON.stringify((await readFixture()).notifications) === JSON.stringify(expected),
    { message: 'The same real rows must persist; only the intended own unread flags may change.' }).toBe(true)
}

async function nativeMetadata(page: Page) {
  const form = main(page).getByRole('form', { name: 'Mark all notifications as read', exact: true })
  const button = form.getByRole('button', { name: 'Mark all as read', exact: true })
  await expect(form).toHaveCount(1)
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('type', 'submit')
  expect(await button.getAttribute('formaction')).toBeNull()
  const metadata = await form.evaluate(element => {
    if (!(element instanceof HTMLFormElement)) throw new Error('Expected the actual native bulk form.')
    const fields = Array.from(element.elements).filter((control): control is HTMLInputElement =>
      control instanceof HTMLInputElement && control.type === 'hidden' && !control.disabled && Boolean(control.name),
    ).map(control => [control.name, control.value] as [string, string])
    return { action: element.action, method: element.method, encoding: element.enctype, target: element.target, fields }
  })
  const references = metadata.fields.filter(([name]) => /^\$ACTION_(?:REF|ID)_/.test(name))
  if (metadata.action !== new URL('/notifications', origin).href || metadata.method !== 'post' ||
    metadata.encoding !== 'multipart/form-data' || !['', '_self'].includes(metadata.target) ||
    metadata.fields.length === 0 || metadata.fields.length > 32 ||
    metadata.fields.some(([name, value]) => !name.startsWith('$ACTION_') || name.length > 256 || value.length > 8192) ||
    references.length !== 1 || metadata.fields.filter(([name]) => name === '$ACTION_KEY').length !== 1) {
    throw new Error('The real no-JS form must supply bounded generated action metadata and an exact same-origin POST target.')
  }
  if (references[0][0].startsWith('$ACTION_REF_')) {
    const descriptor = `$ACTION_${references[0][0].slice('$ACTION_REF_'.length)}:0`
    if (metadata.fields.filter(([name]) => name === descriptor).length !== 1) {
      throw new Error('The generated bound-action reference must have its real descriptor.')
    }
  }
  return { button, metadata }
}

async function nativeBulk(
  page: Page, activities: readonly Activity[], expected: readonly LocalNotification[],
  marked: number, withheld: readonly string[],
) {
  const { button, metadata } = await nativeMetadata(page)
  const response = await submit(page, button, async () => {
    await exactRows(expected)
    await fullList(page, activities, activities.map(row => row.id))
  })
  const request = response.request()
  if (request.url() !== metadata.action || response.url() !== metadata.action ||
    request.method() !== 'POST' || !request.isNavigationRequest() || request.frame() !== page.mainFrame() ||
    request.redirectedFrom() !== null || response.status() !== 200 ||
    await request.headerValue('origin') !== origin || await request.headerValue('next-action') !== null) {
    throw new Error('Bulk evidence must be the actual native same-origin POST document, not a GET or hydrated dispatch.')
  }
  const bytes = request.postDataBuffer()
  const contentType = await request.headerValue('content-type')
  if (!bytes || bytes.length === 0 || bytes.length > maxActionBytes ||
    !contentType || !/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw new Error('The actual native submission must contain a bounded multipart action body.')
  }
  let entries: [string, FormDataEntryValue][]
  try {
    const data = await new globalThis.Response(new Uint8Array(bytes), {
      headers: { 'content-type': contentType },
    }).formData()
    entries = [...data.entries()]
  } catch {
    throw new Error('The actual native action body could not be inspected.')
  }
  const sorted = (fields: readonly (readonly [string, unknown])[]) =>
    [...fields].sort(([left], [right]) => left.localeCompare(right))
  expect(entries.every(([, value]) => typeof value === 'string') &&
    JSON.stringify(sorted(entries)) === JSON.stringify(sorted(metadata.fields)),
  'The browser must submit exactly its own generated form metadata, without guessed IDs or recipient fields.').toBe(true)
  await privateDocument(page, response, withheld)
  // Count/zero announcements are part of this UX, not optional evidence.
  const statuses = main(page).getByRole('status')
  await expect(statuses).toHaveCount(1)
  await expect(statuses).toHaveText(marked ? `${marked} marked as read.` : 'Nothing was unread.')
  await expect(main(page).getByText('Marking notifications as read…', { exact: true })).toHaveCount(0)
  await exactRows(expected)
}

test('real single-read and no-JS bulk preserve recipient ownership, privacy and stale reconciliation', async ({
  page, context, browser, baseURL,
}, info: TestInfo) => {
  // Keep the existing 90s test/20s action/60s navigation/120s startup budgets.
  if (localOrigin(baseURL) !== origin || info.retry !== 0 || info.repeatEachIndex !== 0) {
    throw new Error('A fresh unrepeated isolated notification journey is required.')
  }
  const contexts: BrowserContext[] = []
  let exceptions = 0
  let networkViolations = 0
  const watch = (candidate: Page) => candidate.on('pageerror', () => { exceptions += 1 })
  const violation = () => { networkViolations += 1 }
  watch(page)
  await localNetwork(context, violation)
  expect((await context.cookies()).length).toBe(0)
  const extraContext = async (javaScriptEnabled: boolean) => {
    const extra = await browser.newContext({
      baseURL: origin, javaScriptEnabled, storageState: { cookies: [], origins: [] },
      serviceWorkers: 'block', viewport: { width: 1440, height: 960 }, colorScheme: 'light',
    })
    contexts.push(extra)
    await localNetwork(extra, violation)
    expect((await extra.cookies()).length).toBe(0)
    return extra
  }
  try {
    const bobContext = await extraContext(true)
    const bobPage = await bobContext.newPage()
    watch(bobPage)
    const suffix = randomBytes(4).toString('hex')
    const alice = await signup(page, `nr_a_${suffix}`, `Notification Alice ${suffix}`)
    const bob = await signup(bobPage, `nr_b_${suffix}`, `Notification Bob ${suffix}`)
    await connect(page, bobPage, alice, bob)
    const direct = await directConversation(bobPage, alice)
    const first = await send(bobPage, bob, alice, direct, `BullaPrivateDm_${suffix}`)
    await visit(page, `/messages?c=${direct}`, 'Messages')
    const foreign = await send(page, alice, bob, direct, `BullaPrivateReply_${suffix}`)
    const own: Activity[] = [first]
    for (const label of ['one', 'two']) {
      const group = await groupConversation(bobPage, bob, alice, `Notification group ${label} ${suffix}`)
      own.push(await send(bobPage, bob, alice, group, `BullaPrivateGroup_${label}_${suffix}`))
    }
    const initial = await readFixture()
    expect(initial.users.length).toBe(2)
    expect(initial.profiles.length).toBe(2)
    expect(initial.conversations.length).toBe(3)
    expect(initial.messages.length).toBe(4)
    expect(initial.notifications.length).toBe(4)
    expect(initial.notifications.every(row => row.type === 'message' && row.body === null && row.is_read === false)).toBe(true)
    const bodies = [...own.map(row => row.body), foreign.body]
    const aliceWithheld = [...bodies, foreign.id]
    const bobWithheld = [...bodies, ...own.map(row => row.id)]

    await test.step('opening the bell is read-only; the complete list and real badge agree', async () => {
      const response = await visit(page, '/me', alice.displayName)
      await privateDocument(page, response, aliceWithheld)
      await badge(page, 3)
      let posts = 0
      const observe = (request: import('@playwright/test').Request) => {
        if (request.method() === 'POST') posts += 1
      }
      page.on('request', observe)
      try {
        const beforeURL = page.url()
        await bell(page).click()
        const panel = page.getByRole('dialog', { name: 'Notifications', exact: true })
        await expect(panel).toBeVisible()
        await expect(panel).toHaveAttribute('aria-modal', 'false')
        await expect(page).toHaveURL(beforeURL)
        await expect(bell(page)).toHaveAttribute('aria-expanded', 'true')
        const recent = panel.getByRole('list', { name: 'Recent notifications', exact: true })
        await expect(recent.getByRole('listitem')).toHaveCount(3)
        await expect(recent.getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(3)
        await page.evaluate(() => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }))
        await exactRows(initial.notifications)
        await panel.getByRole('link', { name: 'View all notifications', exact: true }).click()
        await fullList(page, own, [])
        expect(posts, 'Opening the bell and its overview link must not mark anything read').toBe(0)
      } finally { page.off('request', observe) }
      await exactRows(initial.notifications)
      await privateDocument(page, await page.reload({ waitUntil: 'domcontentloaded' }), aliceWithheld)
      await fullList(page, own, [])
    })

    const singleRead = markedRows(initial.notifications, [first.id])
    await test.step('a full-page single-read changes only its owned row and survives reload', async () => {
      const row = activityRow(page, first)
      await expect(row.locator('input[name="id"]')).toHaveValue(first.id)
      await submit(page, row.getByRole('button', { name: 'Mark as read', exact: true }), async () => {
        await exactRows(singleRead)
        await expect(row.getByRole('status')).toHaveText('Notification marked as read.')
        await fullList(page, own, [first.id])
      })
      await privateDocument(page, await page.reload({ waitUntil: 'domcontentloaded' }), aliceWithheld)
      await fullList(page, own, [first.id])
      await exactRows(singleRead)
    })

    const allRead = markedRows(singleRead, own.map(row => row.id))
    await test.step('native no-JS bulk uses its generated metadata and preserves the other recipient', async () => {
      const noJS = await extraContext(false)
      const cookie = await sessionCookie(page, alice)
      try { await noJS.addCookies([cookie]) } catch {
        throw new Error('Alice’s own synthetic cookie could not be copied to her no-JS context.')
      }
      const native = await noJS.newPage()
      const stale = await noJS.newPage()
      watch(native)
      watch(stale)
      await sessionCookie(native, alice)
      await privateDocument(native, await visit(native, '/notifications', 'Notifications'), aliceWithheld)
      await fullList(native, own, [first.id])
      await privateDocument(stale, await visit(stale, '/notifications', 'Notifications'), aliceWithheld)
      await fullList(stale, own, [first.id])
      await nativeMetadata(stale)
      await nativeBulk(native, own, allRead, 2, aliceWithheld)
      await privateDocument(native, await native.reload({ waitUntil: 'domcontentloaded' }), aliceWithheld)
      await fullList(native, own, own.map(row => row.id))
      await exactRows(allRead)

      await expect(main(stale).getByText('2 unread.', { exact: true })).toBeVisible()
      await badge(stale, 2)
      await nativeBulk(stale, own, allRead, 0, aliceWithheld)
      await privateDocument(stale, await stale.reload({ waitUntil: 'domcontentloaded' }), aliceWithheld)
      await fullList(stale, own, own.map(row => row.id))
      await privateDocument(page, await page.reload({ waitUntil: 'domcontentloaded' }), aliceWithheld)
      await fullList(page, own, own.map(row => row.id))
      await privateDocument(bobPage, await visit(bobPage, '/notifications', 'Notifications'), bobWithheld)
      await fullList(bobPage, [foreign], [])
      await privateDocument(bobPage, await bobPage.reload({ waitUntil: 'domcontentloaded' }), bobWithheld)
      await fullList(bobPage, [foreign], [])
      await exactRows(allRead)
    })

    const final = await readFixture()
    for (const table of ['messages', 'connections', 'conversation_participants'] as const) {
      expect(JSON.stringify(final[table]) === JSON.stringify(initial[table]),
        'Notification controls must not mutate message bodies, consent or conversation-read state.').toBe(true)
    }
    expect(exceptions, 'No browser page exception is an accepted outcome').toBe(0)
    expect(networkViolations, 'No non-fixture/provider request is permitted').toBe(0)
  } finally {
    for (const extra of contexts) await extra.close()
  }
})
