import { test, expect, type Page } from '@playwright/test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeAction } from './helpers/complete-action'
import type {
  LocalMessage,
  LocalNotification,
  Tables,
} from '../../src/lib/local/db'
import type { MessageMembership } from '../../src/features/messages/local-access'

/**
 * Local browser acceptance, not hosted transport/concurrency proof.
 *
 * Both accounts and their opaque sessions are created through signup/onboarding.
 * Groups use real accepted-connection/create/member/role/re-add controls.
 * Setup appends only non-message notification-read fixtures. Message activity
 * is delivered by real accepted sends. No group membership or role is seeded.
 */
type Fixture = Tables & { message_memberships?: MessageMembership[] }
type SentMessage = LocalMessage & { client_nonce?: string }
type Account = { profileId: string; handle: string; displayName: string }
type KeptDraft = { body: string; clientNonce: string; stored: string }
type SetupRows = {
  notifications?: LocalNotification[]
}

const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let fixtureRoot: string
let fixtureFile: string

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Collaboration fixtures must stay inside their isolated harness directory.')
  }
}

test.beforeAll(async () => {
  const root = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(root) || !run || !/^[a-zA-Z0-9-]+$/.test(run) ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Collaboration tests require a fresh isolated Playwright harness, never a reused owner server.')
  }
  const runRoot = path.resolve(root, run)
  assertInside(root, runRoot)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)
  fixtureRoot = path.join(runRoot, 'fixture')
  await fs.mkdir(fixtureRoot, { recursive: true })
  if (process.platform === 'win32') {
    assertInside(await fs.realpath(recoveryRoot), await fs.realpath(fixtureRoot))
  }
  const marker = await fs.open(path.join(fixtureRoot, 'collaboration-fixture.marker'), 'wx', 0o600)
  await marker.close()
  fixtureFile = path.join(fixtureRoot, 'local.json')
})

async function readFixture(): Promise<Fixture> {
  assertInside(fixtureRoot, fixtureFile)
  const stat = await fs.lstat(fixtureFile)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular isolated local fixture.')
  const parsed: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some((rows) => !Array.isArray(rows))) {
    throw new Error('Invalid isolated local fixture; refusing to replace it.')
  }
  const snapshot = parsed as Fixture
  for (const name of ['users', 'sessions', 'profiles', 'conversations', 'conversation_participants', 'messages', 'notifications'] as const) {
    if (!Array.isArray(snapshot[name])) throw new Error(`Missing isolated fixture table: ${name}`)
  }
  return snapshot
}

/** Same bounded lock/atomic rename as the store; never reset sessions or budgets. */
async function appendSetup(rows: SetupRows) {
  const lock = `${fixtureFile}.lock`
  const temp = `${fixtureFile}.collaboration.${randomUUID()}.tmp`
  assertInside(fixtureRoot, lock)
  assertInside(fixtureRoot, temp)
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await fs.mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error('Isolated collaboration fixture is busy; no setup was written.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    const snapshot = await readFixture()
    function append<T extends { id: string }>(table: T[], additions: T[]) {
      for (const row of additions) {
        if (table.some((existing) => existing.id === row.id)) throw new Error('Synthetic fixture identifier collision.')
        table.push(row)
      }
    }
    if (rows.notifications) append(snapshot.notifications, rows.notifications)
    const handle = await fs.open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, fixtureFile)
  } finally {
    try {
      await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    } finally {
      // This invocation acquired this exact empty lock; no recursive cleanup.
      await fs.rmdir(lock)
    }
  }
}

function thread(page: Page) {
  return page.locator('section[aria-labelledby="thread-heading"]')
}

function composer(page: Page) {
  return thread(page).locator('form').filter({ has: page.locator('textarea[name="body"]') })
}

function inboxLink(page: Page, conversationId: string) {
  return page.locator(`aside ul a[href="/messages?c=${conversationId}"]`)
}

function unreadNotification(page: Page, id: string) {
  return page.locator('li').filter({
    has: page.locator(`input[name="id"][value="${id}"]`),
  })
}

function messageActivities(snapshot: Fixture, recipient: Account, actor: Account, conversationId: string) {
  return snapshot.notifications.filter(row => row.type === 'message' &&
    row.recipient_id === recipient.profileId && row.actor_id === actor.profileId &&
    row.conversation_id === conversationId)
}

async function storedDraft(page: Page, conversationId: string) {
  return page.evaluate((id) => sessionStorage.getItem(`quad.messages.draft.${id}`), conversationId)
}

async function signup(page: Page, handle: string, displayName: string): Promise<Account> {
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(`${handle}@example.test`)
  await page.getByLabel(/^Password/).fill(randomBytes(24).toString('base64url'))
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await page.getByLabel(/^Choose a username/).fill(handle)
  await page.getByLabel(/^Who can see your profile/).selectOption('public')
  await page.getByRole('button', { name: 'Finish and go to my profile', exact: true }).click()
  await expect(page).toHaveURL(/\/me$/)
  const cookie = (await page.context().cookies()).find((row) => row.name === 'quad_local_session')
  expect(cookie).toBeTruthy()
  expect(cookie?.httpOnly).toBe(true)
  const snapshot = await readFixture()
  const profile = snapshot.profiles.find((row) => row.username === handle)
  expect(profile).toBeTruthy()
  expect(snapshot.sessions.some((row) => row.user_id === profile!.user_id &&
    row.token_hash === createHash('sha256').update(cookie!.value).digest('hex'))).toBe(true)
  return { profileId: profile!.id, handle, displayName }
}

async function setIncomingDMs(page: Page, account: Account, value: 'everyone' | 'nobody') {
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByText('Who can send you direct messages', { exact: true })).toBeVisible()
  await expect(page.getByText(
    'No new direct conversations or incoming direct messages, including in existing conversations. Your readable history stays.',
    { exact: true },
  )).toBeVisible()
  const radio = page.getByRole('radio', { name: value === 'nobody' ? /^Nobody/ : /^Anyone on Bulla/ })
  await radio.check()
  await page.getByRole('button', { name: 'Save privacy settings', exact: true }).click()
  await expect(page.getByText('Privacy settings saved.', { exact: true })).toBeVisible()
  await expect.poll(async () =>
    (await readFixture()).profiles.find((row) => row.id === account.profileId)?.allow_messages_from,
  ).toBe(value)
  await page.reload()
  await expect(radio).toBeChecked()
}

async function requestDM(page: Page, handle: string) {
  await page.goto('/messages')
  await expect(page).toHaveURL(/\/messages$/)
  const panel = page.locator('aside details').filter({
    has: page.locator('summary').filter({ hasText: /^New message$/ }),
  })
  await panel.locator('summary').filter({ hasText: /^New message$/ }).click()
  await panel.getByRole('textbox', { name: /^Their handle/ }).fill(handle)
  await panel.getByRole('button', { name: 'Start conversation', exact: true }).click()
}

async function connectAccounts(requesterPage: Page, recipientPage: Page, requester: Account, recipient: Account) {
  await requesterPage.goto(`/u/${recipient.handle}`)
  await expect(requesterPage).toHaveURL(url => url.pathname === `/u/${recipient.handle}`)
  await requesterPage.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(requesterPage.getByText('Request sent', { exact: true })).toBeVisible()
  await expect.poll(async () => (await readFixture()).connections.some(row =>
    row.requester_id === requester.profileId && row.addressee_id === recipient.profileId && row.status === 'pending',
  )).toBe(true)
  await recipientPage.goto(`/u/${requester.handle}`)
  await expect(recipientPage).toHaveURL(url => url.pathname === `/u/${requester.handle}`)
  await recipientPage.getByRole('button', { name: /^Accept the connection request from/ }).click()
  await expect(recipientPage.getByText('Connected', { exact: true })).toBeVisible()
  await expect.poll(async () => (await readFixture()).connections.some(row =>
    row.requester_id === requester.profileId && row.addressee_id === recipient.profileId && row.status === 'accepted',
  )).toBe(true)
}

async function createGroup(page: Page, title: string, handles: string, skipped: number) {
  await page.goto('/messages')
  await expect(page).toHaveURL(/\/messages$/)
  await page.locator('aside summary').filter({ hasText: /^New message$/ }).click()
  await page.locator('aside summary').filter({ hasText: /^Create group$/ }).click()
  await page.getByRole('textbox', { name: /^Group name/ }).fill(title)
  await page.getByRole('textbox', { name: /^Group handles/ }).fill(handles)
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Group created. 1 person added.' })).toBeVisible()
  if (skipped) await expect(page.getByText(new RegExp(`${skipped} not added\\.`))).toBeVisible()
  await page.getByRole('link', { name: 'Open group', exact: true }).click()
  await expect(page).toHaveURL(/\/messages\?c=cnv_[a-z0-9]+$/)
  const groupId = new URL(page.url()).searchParams.get('c')!
  await expect(thread(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  return groupId
}

async function openMembers(page: Page, count: number) {
  const details = thread(page).locator('details').filter({
    has: page.locator('summary').filter({ hasText: new RegExp(`^Members \\(${count}\\)$`) }),
  })
  await expect(details).toHaveCount(1)
  if (await details.getAttribute('open') === null) {
    await details.locator('summary').filter({ hasText: /^Members / }).click()
  }
  return details
}

async function saveGroupRole(page: Page, account: Account, role: 'admin' | 'member', groupId: string) {
  const members = await openMembers(page, 2)
  await members.getByRole('combobox', { name: `Role for ${account.displayName}`, exact: true }).selectOption(role)
  await members.getByRole('button', { name: `Save role for ${account.displayName}`, exact: true }).click()
  await expect.poll(async () => (await readFixture()).conversation_participants.find(row =>
    row.conversation_id === groupId && row.profile_id === account.profileId,
  )?.role).toBe(role)
}

function directPair(snapshot: Fixture, alice: Account, bob: Account) {
  return snapshot.conversations.filter((conversation) => {
    if (conversation.type !== 'direct') return false
    const members = snapshot.conversation_participants.filter((row) => row.conversation_id === conversation.id)
    return members.length === 2 && [alice.profileId, bob.profileId]
      .every((profileId) => members.some((row) => row.profile_id === profileId))
  })
}

async function prepareDraft(page: Page, conversationId: string, body: string): Promise<KeptDraft> {
  await expect(composer(page).locator('input[name="conversationId"]')).toHaveValue(conversationId)
  const input = thread(page).getByRole('textbox', { name: 'Message', exact: true })
  await expect(input).toBeEnabled()
  const previous = await storedDraft(page, conversationId)
  if (previous) await expect(input).toHaveValue((JSON.parse(previous) as { body: string }).body)
  await input.fill(body)
  await expect(input).toHaveValue(body)
  await expect.poll(async () => {
    const stored = await storedDraft(page, conversationId)
    return stored ? (JSON.parse(stored) as { body: string }).body : null
  }).toBe(body)
  const stored = (await storedDraft(page, conversationId))!
  const { clientNonce } = JSON.parse(stored) as { clientNonce: string }
  expect(clientNonce).toMatch(uuid)
  const nonce = composer(page).locator('input[name="clientNonce"]')
  await expect(nonce).toHaveValue(clientNonce)
  expect(JSON.parse(stored)).toEqual({ body, clientNonce })
  return { body, clientNonce, stored }
}

async function expectDraft(page: Page, draft: KeptDraft) {
  await expect(thread(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft.body)
  await expect(composer(page).locator('input[name="clientNonce"]')).toHaveValue(draft.clientNonce)
}

async function messagesWithBody(conversationId: string, body: string): Promise<SentMessage[]> {
  return (await readFixture()).messages.filter((row) =>
    row.conversation_id === conversationId && row.body === body,
  )
}

async function acceptDraft(page: Page, conversationId: string, draft: KeptDraft) {
  await expectDraft(page, draft)
  await thread(page).getByRole('button', { name: 'Send', exact: true }).click()
  // Await the success effect, not just streamed action output, before reload.
  await expect(thread(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
  await expect.poll(() => storedDraft(page, conversationId)).toBeNull()
  await expect(thread(page).getByText(draft.body, { exact: true })).toHaveCount(1)
  const messages = await messagesWithBody(conversationId, draft.body)
  expect(messages).toHaveLength(1)
  expect(messages[0].client_nonce).toBe(draft.clientNonce)
  return messages[0]
}

async function refuseDraft(page: Page, conversationId: string, draft: KeptDraft, refusal: string) {
  await expectDraft(page, draft)
  await thread(page).getByRole('button', { name: 'Send', exact: true }).click()
  await expect(thread(page).getByRole('alert').filter({ hasText: refusal })).toBeVisible()
  await expect(thread(page).getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expectDraft(page, draft)
  expect(await storedDraft(page, conversationId)).toBe(draft.stored)
  expect(await messagesWithBody(conversationId, draft.body)).toHaveLength(0)
}

async function waitUntilRead(conversationId: string, profileId: string, createdAt: string) {
  await expect.poll(async () => {
    const member = (await readFixture()).conversation_participants.find((row) =>
      row.conversation_id === conversationId && row.profile_id === profileId,
    )
    return Boolean(member?.last_read_at && Date.parse(member.last_read_at) >= Date.parse(createdAt))
  }).toBe(true)
}

function unreadLabel(count: number) {
  return count === 0 ? 'Nothing unread.' : count === 1 ? 'One unread.' : `${count} unread.`
}

test('two-account messages and real groups, retained retries, consent, roles/re-add, cutoff activity and blocking', async ({ page: alicePage, browser, baseURL }, testInfo) => {
  // This long two-account journey reached its final notification controls at
  // the former five-minute ceiling under measured cold local compilation.
  // Keep each action/assertion bounded; allow the complete sequence to finish.
  test.setTimeout(600_000)
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
    throw new Error('Collaboration acceptance is loopback-only.')
  }
  const bobContext = await browser.newContext({ baseURL })
  const bobPage = await bobContext.newPage()
  const suffix = randomBytes(6).toString('hex')
  const pageErrors: string[] = []
  alicePage.on('pageerror', (error) => pageErrors.push(`Alice: ${error.message}`))
  bobPage.on('pageerror', (error) => pageErrors.push(`Bob: ${error.message}`))
  try {
    await test.step('real signup sessions and the signed-out conversation guard', async () => {
      await alicePage.goto('/messages')
      await expect(alicePage).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('next') === '/messages')
      await expect(thread(alicePage)).toHaveCount(0)
      expect((await alicePage.context().cookies()).some((row) => row.name === 'quad_local_session')).toBe(false)
    })
    const alice = await signup(alicePage, `collab_a_${suffix}`, `Collaboration Alice ${suffix}`)
    const bob = await signup(bobPage, `collab_b_${suffix}`, `Collaboration Bob ${suffix}`)

    await test.step('Nobody refuses a new DM without creating a conversation', async () => {
      await setIncomingDMs(bobPage, bob, 'nobody')
      await requestDM(alicePage, bob.handle)
      await expect(alicePage.getByRole('alert').filter({
        hasText: 'Messaging is not available with this person.',
      })).toBeVisible()
      await expect(alicePage).toHaveURL(/\/messages$/)
      expect(directPair(await readFixture(), alice, bob)).toHaveLength(0)
    })

    await setIncomingDMs(bobPage, bob, 'everyone')
    await requestDM(alicePage, bob.handle)
    await expect(alicePage).toHaveURL(/\/messages\?c=cnv_[a-z0-9]+$/)
    const conversationId = new URL(alicePage.url()).searchParams.get('c')!
    const dmURL = `/messages?c=${conversationId}`
    await expect(thread(alicePage).getByRole('heading', { name: bob.displayName, exact: true })).toBeVisible()
    expect(directPair(await readFixture(), alice, bob).map((row) => row.id)).toEqual([conversationId])
    const firstBody = `DM retained retry ${suffix}`

    await test.step('draft and nonce survive reload; an accepted retry creates one durable message', async () => {
      const draft = await prepareDraft(alicePage, conversationId, firstBody)
      await alicePage.reload()
      await expect(alicePage).toHaveURL(new URL(dmURL, baseURL).href)
      await expectDraft(alicePage, draft)
      await expect(thread(alicePage).getByText('Your unfinished message was kept in this tab.', { exact: true })).toBeVisible()
      const firstMessage = await acceptDraft(alicePage, conversationId, draft)
      expect(firstMessage.author_id).toBe(alice.profileId)
      const delivered = messageActivities(await readFixture(), bob, alice, conversationId)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({
        body: null, is_read: false, created_at: firstMessage.created_at,
        recipient_id: bob.profileId, actor_id: alice.profileId,
      })
      await bobPage.goto('/notifications')
      await expect(bobPage).toHaveURL(/\/notifications$/)
      const notice = unreadNotification(bobPage, delivered[0].id)
      await expect(notice).toContainText(`${alice.displayName} sent you a message.`)
      await expect(notice.getByRole('link', { name: 'Open the conversation', exact: true })).toHaveAttribute('href', dmURL)
      await expect(bobPage.getByText(firstBody, { exact: true })).toHaveCount(0)
      await notice.getByRole('button', { name: 'Mark as read', exact: true }).click()
      await expect.poll(async () =>
        (await readFixture()).notifications.find(row => row.id === delivered[0].id)?.is_read,
      ).toBe(true)
      const acknowledged = messageActivities(await readFixture(), bob, alice, conversationId)
      // Simulate retained recovery state after a lost acknowledgement/cleanup.
      // Only browser sessionStorage is restored; the server write is NOT mocked.
      // This is observable recovery/idempotency, not a real network interruption.
      await alicePage.evaluate(({ id, stored }) => {
        sessionStorage.setItem(`quad.messages.draft.${id}`, stored)
      }, { id: conversationId, stored: draft.stored })
      await alicePage.reload()
      await expectDraft(alicePage, draft)
      const replay = await acceptDraft(alicePage, conversationId, draft)
      expect(replay.id).toBe(firstMessage.id)
      expect(replay.created_at).toBe(firstMessage.created_at)
      expect(messageActivities(await readFixture(), bob, alice, conversationId)).toEqual(acknowledged)
      await alicePage.reload()
      await expect(thread(alicePage).getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
      await expect(thread(alicePage).getByText(firstBody, { exact: true })).toHaveCount(1)
      await bobPage.goto('/messages')
      await expect(inboxLink(bobPage, conversationId).locator('[aria-label="1 unread"]')).toBeVisible()
      await inboxLink(bobPage, conversationId).click()
      await expect(bobPage).toHaveURL(new URL(dmURL, baseURL).href)
      await expect(thread(bobPage).getByText(firstBody, { exact: true })).toHaveCount(1)
      await waitUntilRead(conversationId, bob.profileId, firstMessage.created_at)
      await bobPage.reload()
      await expect(inboxLink(bobPage, conversationId).locator('[aria-label$=" unread"]')).toHaveCount(0)
    })

    await test.step('Nobody stops stale existing incoming sends, retains history and allows consented outgoing', async () => {
      const refused = await prepareDraft(alicePage, conversationId, `DM after disable ${suffix}`)
      await setIncomingDMs(bobPage, bob, 'nobody')
      await refuseDraft(alicePage, conversationId, refused,
        'You cannot send a message here. The recipient may not be accepting messages.')
      await alicePage.reload()
      await expectDraft(alicePage, refused)
      await expect(thread(alicePage).getByText(firstBody, { exact: true })).toHaveCount(1)
      await bobPage.goto(dmURL)
      await expect(thread(bobPage).getByText(firstBody, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(refused.body, { exact: true })).toHaveCount(0)
      const outgoing = await prepareDraft(bobPage, conversationId, `Outgoing while incoming disabled ${suffix}`)
      const reply = await acceptDraft(bobPage, conversationId, outgoing)
      expect(reply.author_id).toBe(bob.profileId)
      await alicePage.reload()
      await expect(thread(alicePage).getByText(outgoing.body, { exact: true })).toHaveCount(1)
      await expectDraft(alicePage, refused)
      await setIncomingDMs(bobPage, bob, 'everyone')
      const accepted = await acceptDraft(alicePage, conversationId, refused)
      await bobPage.goto('/messages')
      await expect(inboxLink(bobPage, conversationId).locator('[aria-label="1 unread"]')).toBeVisible()
      await inboxLink(bobPage, conversationId).click()
      await expect(bobPage).toHaveURL(new URL(dmURL, baseURL).href)
      await expect(thread(bobPage).getByText(refused.body, { exact: true })).toHaveCount(1)
      await waitUntilRead(conversationId, bob.profileId, accepted.created_at)
      await bobPage.reload()
      await expect(inboxLink(bobPage, conversationId).locator('[aria-label$=" unread"]')).toHaveCount(0)
      await bobPage.screenshot({ path: testInfo.outputPath('dm-readable-history.png'), fullPage: true })
    })

    await test.step('mute suppresses activity, not unread; an unmuted nonce replay does not backfill delivery', async () => {
      await thread(bobPage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await bobPage.getByRole('menuitem', { name: 'Mute notifications', exact: true }).click()
      await expect.poll(async () => (await readFixture()).participant_preferences.find(row =>
        row.conversation_id === conversationId && row.profile_id === bob.profileId,
      )?.is_muted).toBe(true)
      const before = messageActivities(await readFixture(), bob, alice, conversationId)
      const muted = await prepareDraft(alicePage, conversationId, `DM muted but readable ${suffix}`)
      await acceptDraft(alicePage, conversationId, muted)
      expect(messageActivities(await readFixture(), bob, alice, conversationId)).toEqual(before)
      await bobPage.goto('/messages')
      const inbox = inboxLink(bobPage, conversationId)
      await expect(inbox.getByText('Muted', { exact: true })).toBeVisible()
      await expect(inbox.locator('[aria-label="1 unread"]')).toBeVisible()
      const inboxItem = bobPage.locator('aside li').filter({ has: bobPage.locator(`a[href="${dmURL}"]`) })
      await inboxItem.getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await bobPage.getByRole('menuitem', { name: 'Unmute notifications', exact: true }).click()
      await expect.poll(async () => (await readFixture()).participant_preferences.find(row =>
        row.conversation_id === conversationId && row.profile_id === bob.profileId,
      )?.is_muted).toBe(false)
      await alicePage.evaluate(({ id, stored }) => {
        sessionStorage.setItem(`quad.messages.draft.${id}`, stored)
      }, { id: conversationId, stored: muted.stored })
      await alicePage.reload()
      await expectDraft(alicePage, muted)
      await acceptDraft(alicePage, conversationId, muted)
      expect(messageActivities(await readFixture(), bob, alice, conversationId)).toEqual(before)
      const fresh = await prepareDraft(alicePage, conversationId, `DM future unmuted delivery ${suffix}`)
      const accepted = await acceptDraft(alicePage, conversationId, fresh)
      expect(messageActivities(await readFixture(), bob, alice, conversationId)).toEqual([{
        ...before[0], is_read: false, body: null, created_at: accepted.created_at,
      }])
      await bobPage.reload()
      await expect(inbox.locator('[aria-label="2 unread"]')).toBeVisible()
      await inbox.click()
      await expect(bobPage).toHaveURL(new URL(dmURL, baseURL).href)
      await expect(thread(bobPage).getByText(muted.body, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(fresh.body, { exact: true })).toHaveCount(1)
      await waitUntilRead(conversationId, bob.profileId, accepted.created_at)
    })

    await test.step('group departure freezes bodies, inbox preview, activity and unread at the membership cutoff', async () => {
      const title = `Collaboration retained group ${suffix}`
      await connectAccounts(alicePage, bobPage, alice, bob)
      await alicePage.goto(dmURL)
      const independent = await prepareDraft(alicePage, conversationId, `DM draft kept while sending elsewhere ${suffix}`)
      const groupId = await createGroup(alicePage, title, `${bob.handle}, absent_${suffix}`, 1)
      const groupURL = `/messages?c=${groupId}`
      const initialMembers = (await readFixture()).conversation_participants.filter(row => row.conversation_id === groupId)
      expect(initialMembers).toHaveLength(2)
      expect(initialMembers.find(row => row.profile_id === alice.profileId)?.role).toBe('admin')
      expect(initialMembers.find(row => row.profile_id === bob.profileId)?.role).toBe('member')
      await thread(alicePage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await expect(alicePage.getByRole('menuitem', { name: 'Leave conversation', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await expect(alicePage.getByRole('menu').getByText(
        'You are the final active admin. Make another active member an admin before leaving or changing your role.',
        { exact: true },
      )).toBeVisible()
      await alicePage.keyboard.press('Escape')
      const retained = await prepareDraft(alicePage, groupId, `Group readable before leave ${suffix}`)
      const before = await acceptDraft(alicePage, groupId, retained)
      // A successful send in A followed by a real client inbox navigation to B
      // must not carry A's success state into B's retained composer.
      await inboxLink(alicePage, conversationId).click()
      await expect(alicePage).toHaveURL(new URL(dmURL, baseURL).href)
      await expectDraft(alicePage, independent)
      await inboxLink(alicePage, groupId).click()
      await expect(alicePage).toHaveURL(new URL(groupURL, baseURL).href)
      const retainedActivity = messageActivities(await readFixture(), bob, alice, groupId)
      expect(retainedActivity).toHaveLength(1)
      expect(retainedActivity[0]).toMatchObject({ body: null, created_at: before.created_at })
      await bobPage.goto('/messages')
      const row = inboxLink(bobPage, groupId)
      await expect(row.getByText(retained.body, { exact: true })).toBeVisible()
      await expect(row.locator('[aria-label="1 unread"]')).toBeVisible()
      await expect(row.locator('time')).toHaveAttribute('datetime', before.created_at)
      await row.click()
      await expect(bobPage).toHaveURL(new URL(groupURL, baseURL).href)
      await expect(thread(bobPage).getByText(retained.body, { exact: true })).toHaveCount(1)
      await waitUntilRead(groupId, bob.profileId, before.created_at)
      await bobPage.reload()
      const bobMembers = await openMembers(bobPage, 2)
      await expect(bobMembers.locator('summary').filter({ hasText: /^Add people$/ })).toHaveCount(0)
      await expect(bobMembers.getByRole('combobox')).toHaveCount(0)
      await thread(bobPage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await bobPage.getByRole('menuitem', { name: 'Leave conversation', exact: true }).click()
      await expect(thread(bobPage).getByText('You left this conversation', { exact: true })).toBeVisible()
      await expect(thread(bobPage).getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0)
      const departedSnapshot = await readFixture()
      const cutoff = departedSnapshot.participant_preferences.find((row) =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )?.left_at
      expect(cutoff).toBeTruthy()
      expect(departedSnapshot.message_memberships?.find((row) =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )?.left_at).toBe(cutoff)
      const readAtDeparture = departedSnapshot.conversation_participants.find((row) =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )?.last_read_at
      // Establish a strict post-T instant rather than relying on a fixed sleep.
      await expect.poll(() => Date.now(), { timeout: 5_000, intervals: [20, 50, 100] }).toBeGreaterThan(Date.parse(cutoff!))
      const hidden = await prepareDraft(alicePage, groupId, `Group secret after leave ${suffix}`)
      const after = await acceptDraft(alicePage, groupId, hidden)
      expect(Date.parse(after.created_at)).toBeGreaterThan(Date.parse(cutoff!))
      expect(messageActivities(await readFixture(), bob, alice, groupId)).toEqual(retainedActivity)
      await bobPage.goto('/messages')
      await expect(row.getByText('You left', { exact: true })).toBeVisible()
      await expect(row.getByText(retained.body, { exact: true })).toBeVisible()
      await expect(row.locator('time')).toHaveAttribute('datetime', before.created_at)
      await expect(row.locator('[aria-label$=" unread"]')).toHaveCount(0)
      await expect(bobPage.getByText(hidden.body, { exact: true })).toHaveCount(0)
      await bobPage.locator('aside li').filter({ has: bobPage.locator(`a[href="${groupURL}"]`) })
        .getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await expect(bobPage.getByRole('menuitem', { name: 'Leave conversation', exact: true })).toHaveCount(0)
      await bobPage.keyboard.press('Escape')
      await row.click()
      await expect(bobPage).toHaveURL(new URL(groupURL, baseURL).href)
      const response = await bobPage.reload()
      expect(response?.status()).toBe(200)
      // Check serialized HTML/RSC as well as visible text and the safe summary.
      expect(await response!.text()).not.toContain(hidden.body)
      await expect(thread(bobPage).getByText(retained.body, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(hidden.body, { exact: true })).toHaveCount(0)
      await expect(thread(bobPage).getByText('You left this conversation', { exact: true })).toBeVisible()
      await expect(thread(bobPage).getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0)
      await expect(row.locator('[aria-label$=" unread"]')).toHaveCount(0)
      await expect(row.locator('time')).toHaveAttribute('datetime', before.created_at)
      await thread(bobPage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await expect(bobPage.getByRole('menuitem', { name: 'Leave conversation', exact: true })).toHaveCount(0)
      await bobPage.keyboard.press('Escape')
      expect((await readFixture()).conversation_participants.find((member) =>
        member.conversation_id === groupId && member.profile_id === bob.profileId,
      )?.last_read_at).toBe(readAtDeparture)
      await bobPage.screenshot({ path: testInfo.outputPath('group-retained-cutoff.png'), fullPage: true })
      const notificationsResponse = await bobPage.goto('/notifications')
      await expect(bobPage).toHaveURL(/\/notifications$/)
      expect(await notificationsResponse!.text()).not.toContain(hidden.body)
      const oldActivity = unreadNotification(bobPage, retainedActivity[0].id)
      await expect(oldActivity.getByRole('link', { name: 'Open the conversation', exact: true })).toHaveAttribute('href', groupURL)
      await oldActivity.getByRole('link', { name: 'Open the conversation', exact: true }).click()
      await expect(bobPage).toHaveURL(new URL(groupURL, baseURL).href)
      await expect(thread(bobPage).getByText(retained.body, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(hidden.body, { exact: true })).toHaveCount(0)

      // A real active-admin re-add opens only a fresh interval. The saved gap is
      // still absent from the visible thread and serialized HTML/RSC after rejoin.
      const aliceMembers = await openMembers(alicePage, 1)
      await aliceMembers.getByRole('button', { name: `Re-add ${bob.displayName}`, exact: true }).click()
      await expect.poll(async () => (await readFixture()).participant_preferences.find(row =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )?.left_at).toBeNull()
      const rejoined = (await readFixture()).message_memberships!.filter(row =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )
      expect(rejoined).toHaveLength(2)
      expect(rejoined[0].left_at).toBe(cutoff)
      expect(Date.parse(rejoined[1].joined_at)).toBeGreaterThan(Date.parse(after.created_at))
      const rejoinResponse = await bobPage.reload()
      expect(await rejoinResponse!.text()).not.toContain(hidden.body)
      await expect(thread(bobPage).getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
      await expect(thread(bobPage).getByText(retained.body, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(hidden.body, { exact: true })).toHaveCount(0)
      const freshGroup = await prepareDraft(alicePage, groupId, `Group permitted after re-add ${suffix}`)
      await acceptDraft(alicePage, groupId, freshGroup)
      await bobPage.reload()
      await expect(thread(bobPage).getByText(freshGroup.body, { exact: true })).toHaveCount(1)
      await expect(thread(bobPage).getByText(hidden.body, { exact: true })).toHaveCount(0)

      await saveGroupRole(alicePage, bob, 'admin', groupId)
      await saveGroupRole(alicePage, alice, 'member', groupId)
      await expect((await openMembers(alicePage, 2)).getByRole('combobox')).toHaveCount(0)
      await bobPage.reload()
      await thread(bobPage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await expect(bobPage.getByRole('menuitem', { name: 'Leave conversation', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await bobPage.keyboard.press('Escape')
      await saveGroupRole(bobPage, alice, 'admin', groupId)
      await thread(bobPage).getByRole('button', { name: 'Conversation actions', exact: true }).click()
      await bobPage.getByRole('menuitem', { name: 'Leave conversation', exact: true }).click()
      await expect(thread(bobPage).getByText('You left this conversation', { exact: true })).toBeVisible()
      await alicePage.reload()
      await (await openMembers(alicePage, 1)).getByRole('button', { name: `Re-add ${bob.displayName}`, exact: true }).click()
      await expect.poll(async () => (await readFixture()).conversation_participants.find(row =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )?.role).toBe('member')
      expect((await readFixture()).message_memberships!.filter(row =>
        row.conversation_id === groupId && row.profile_id === bob.profileId,
      )).toHaveLength(3)
      // Neither real role handoff nor a second re-add merges the first absence.
      const secondRejoin = await bobPage.reload()
      expect(await secondRejoin!.text()).not.toContain(hidden.body)
      await expect(thread(bobPage).getByText(hidden.body, { exact: true })).toHaveCount(0)
    })

    await test.step('recipient-only notifications support one-read, mark-all and reload', async () => {
      const two = `Synthetic Bob notification two ${suffix}`
      const aliceOnly = `Synthetic Alice-only notification ${suffix}`
      function notification(recipient: Account, body: string): LocalNotification {
        return {
          id: `ntf_${randomBytes(12).toString('hex')}`, recipient_id: recipient.profileId,
          actor_id: null, type: 'achievement_awarded', body, is_read: false,
          created_at: new Date().toISOString(), post_id: null, comment_id: null,
          project_id: null, idea_id: null, event_id: null, opportunity_id: null, conversation_id: null,
        }
      }
      // Real DM activity, not a synthetic message-body notification. Identify
      // it by its recipient-owned mark-read form, which disappears after read.
      const delivered = messageActivities(await readFixture(), bob, alice, conversationId)
      expect(delivered).toHaveLength(1)
      const bobOne = delivered[0]
      expect(bobOne).toMatchObject({ body: null, is_read: false })
      const bobTwo = notification(bob, two)
      const aliceNotice = notification(alice, aliceOnly)
      await appendSetup({ notifications: [bobTwo, aliceNotice] })
      const unreadBefore = (await readFixture()).notifications.filter((row) =>
        row.recipient_id === bob.profileId && !row.is_read,
      ).length
      await bobPage.goto('/notifications')
      await expect(bobPage).toHaveURL(/\/notifications$/)
      await expect(bobPage.getByRole('heading', { level: 1, name: 'Notifications', exact: true })).toBeVisible()
      await expect(bobPage.getByText(unreadLabel(unreadBefore), { exact: true })).toBeVisible()
      const firstRow = unreadNotification(bobPage, bobOne.id)
      await expect(firstRow).toContainText(`${alice.displayName} sent you a message.`)
      await expect(firstRow.getByRole('link', { name: 'Open the conversation', exact: true })).toHaveAttribute('href', dmURL)
      await expect(bobPage.getByText(aliceOnly, { exact: true })).toHaveCount(0)
      await alicePage.goto('/notifications')
      await expect(alicePage.getByText(aliceOnly, { exact: true })).toBeVisible()
      await expect(alicePage.locator(`input[name="id"][value="${bobOne.id}"]`)).toHaveCount(0)
      await expect(alicePage.getByText(two, { exact: true })).toHaveCount(0)
      await firstRow.getByRole('button', { name: 'Mark as read', exact: true }).click()
      await expect.poll(async () =>
        (await readFixture()).notifications.find((row) => row.id === bobOne.id)?.is_read,
      ).toBe(true)
      await bobPage.reload()
      await expect(bobPage.locator(`input[name="id"][value="${bobOne.id}"]`)).toHaveCount(0)
      await expect(bobPage.getByText(unreadLabel(unreadBefore - 1), { exact: true })).toBeVisible()
      expect((await readFixture()).notifications.find((row) => row.id === bobTwo.id)?.is_read).toBe(false)
      await completeAction(bobPage, bobPage.getByRole('button', { name: 'Mark all as read', exact: true }), async () => {
        await expect(bobPage.getByRole('status').filter({ hasText: `${unreadBefore - 1} marked as read.` })).toBeVisible()
        await expect.poll(async () =>
          (await readFixture()).notifications.filter((row) => row.recipient_id === bob.profileId && !row.is_read).length,
        ).toBe(0)
      }, 20_000)
      await bobPage.reload()
      await expect(bobPage.getByText('Nothing unread.', { exact: true })).toBeVisible()
      await expect(bobPage.getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(0)
      expect((await readFixture()).notifications.find((row) => row.id === aliceNotice.id)?.is_read).toBe(false)
      await alicePage.reload()
      await expect(alicePage.locator('li').filter({ hasText: aliceOnly })
        .getByRole('button', { name: 'Mark as read', exact: true })).toBeVisible()
    })

    await test.step('a block in the other account rejects the already-open composer and hides subsequent reads', async () => {
      await alicePage.goto(dmURL)
      const blocked = await prepareDraft(alicePage, conversationId, `DM denied by block ${suffix}`)
      await bobPage.goto(`/u/${alice.handle}`)
      await expect(bobPage.getByRole('heading', { level: 1, name: alice.displayName, exact: true })).toBeVisible()
      await bobPage.getByRole('button', { name: `Block ${alice.displayName}`, exact: true }).click()
      const dialog = bobPage.getByRole('dialog', { name: `Block ${alice.displayName}?`, exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: `Block ${alice.displayName}`, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await readFixture()).blocks.some((row) =>
        row.blocker_id === bob.profileId && row.blocked_id === alice.profileId,
      )).toBe(true)
      await refuseDraft(alicePage, conversationId, blocked,
        'You cannot message this person: one of you has blocked the other.')
      for (const current of [alicePage, bobPage]) {
        await current.goto(dmURL)
        await expect(current).toHaveURL(new URL(dmURL, baseURL).href)
        await expect(current.getByRole('alert').filter({ hasText: 'That conversation is not available' })).toBeVisible()
        await expect(thread(current)).toHaveCount(0)
        await expect(current.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0)
        await expect(current.getByText(blocked.body, { exact: true })).toHaveCount(0)
      }
      expect(await storedDraft(alicePage, conversationId)).toBe(blocked.stored)
      expect(await messagesWithBody(conversationId, blocked.body)).toHaveLength(0)
    })
    expect(pageErrors).toEqual([])
  } finally {
    await bobContext.close()
  }
})
