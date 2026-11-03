import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({
  userId: null as string | null,
  tokens: new Map<string, string>(),
  cookieOverride: undefined as string | null | undefined,
  getUser: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: auth.getUser,
  createClient: auth.createClient,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== 'quad_local_session') return undefined
      const raw = auth.cookieOverride === undefined
        ? auth.userId && auth.tokens.get(auth.userId)
        : auth.cookieOverride
      return raw ? { value: raw } : undefined
    },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { readStore, resetLocalCache, type LocalNotification, type LocalProfile, type Tables } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { RATE_LIMITS } from '@/lib/rate-limit/budgets'
import {
  leaveConversationAction,
  sendMessageAction,
  setConversationMutedAction,
  startConversationAction,
} from '@/features/messages/actions'
import { getConversationPane, getTotalUnreadMessages, listThreadMessages } from '@/features/messages/queries'
import {
  canReadConversationActivityLocal,
  messageReportTargetLocal,
  type MessageMembership,
} from '@/features/messages/local-access'
import { markAllReadAction, markOneReadAction } from '@/features/notifications/actions'
import { getNotifications, getTargetIndex, getUnreadNotificationCount, type NotificationRow } from '@/features/notifications/queries'
import { emptyTargetIndex, resolveTarget, toNotificationView } from '@/features/notifications/plan'

type Name = 'alice' | 'bob' | 'carol'
type Fixture = Tables & {
  message_memberships: MessageMembership[]
  notification_preferences: { profile_id: string; category: string; in_app_enabled: boolean }[]
}
const CREATED = '2026-10-31T08:00:00.000Z'
const JOIN = '2026-10-31T09:00:00.000Z'
const DURING = '2026-10-31T09:30:00.000Z'
const LEAVE = '2026-10-31T10:00:00.000Z'
const GAP = '2026-10-31T10:30:00.000Z'
const REJOIN = '2026-10-31T11:00:00.000Z'
let workspace: TempWorkspace | undefined
let fixtureFile: string
let accounts: Record<Name, LocalProfile>
let conversationId: string
let otherConversationId: string

function localId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

function profile(name: Name): LocalProfile {
  return {
    id: localId('prf'), user_id: localId('usr'), username: `activity_${name}_${randomBytes(5).toString('hex')}`,
    display_name: `Synthetic activity ${name}`, bio: null, avatar_url: null,
    university_id: 'uni_synthetic', department: null, programme: null, semester: null,
    website: null, github: null, visibility: 'public', searchable: true,
    allow_messages_from: 'everyone', created_at: CREATED,
  }
}

function form(values: Record<string, string>) {
  const result = new FormData()
  for (const [name, value] of Object.entries(values)) result.set(name, value)
  return result
}

function as(name: Name) {
  auth.userId = accounts[name].user_id
}

function send(body: string, clientNonce = randomUUID(), threadId = conversationId) {
  return sendMessageAction({ status: 'idle' }, form({ conversationId: threadId, body, clientNonce }))
}

function activity(overrides: Partial<LocalNotification> = {}): LocalNotification {
  return {
    id: localId('ntf'), recipient_id: accounts.bob.id, actor_id: accounts.alice.id,
    type: 'message', body: null, is_read: false, created_at: DURING,
    post_id: null, comment_id: null, project_id: null, idea_id: null,
    event_id: null, opportunity_id: null, conversation_id: conversationId,
    ...overrides,
  }
}

function rowOf(notification: LocalNotification): NotificationRow {
  return { ...notification, actor: null }
}

/** Privileged setup writes only the owned fixture; actions still use db.mutate. */
async function seedFixture(change: (db: Fixture) => void) {
  if (!workspace) throw new Error('No owned message activity fixture')
  const db = await readStore() as Fixture
  change(db)
  await fs.writeFile(fixtureFile, JSON.stringify(db, null, 2), 'utf8')
}

async function makeGroup() {
  await seedFixture(db => {
    db.conversations.find(row => row.id === conversationId)!.type = 'group'
    db.conversation_participants.push({
      id: localId('par'), conversation_id: conversationId,
      profile_id: accounts.carol.id, last_read_at: null,
    })
    db.message_memberships.push({
      conversation_id: conversationId, profile_id: accounts.carol.id, joined_at: JOIN, left_at: null,
    })
  })
}

beforeEach(async () => {
  resetLocalCache()
  auth.tokens.clear()
  auth.cookieOverride = undefined
  auth.getUser.mockReset()
  auth.createClient.mockReset()
  auth.createClient.mockImplementation(() => { throw new Error('Local message activity test reached Supabase') })
  auth.getUser.mockImplementation(async () => (await import('@/lib/local/session')).getLocalUser())
  if (process.platform === 'win32') {
    vi.stubEnv('BULLA_TEST_TMP_DIR', 'D:/All tasks + Automations/Bulla-Recovery/test-fixtures/messaging-activity')
  }
  workspace = await createTempWorkspace('message-activity')
  fixtureFile = path.join(workspace.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', fixtureFile)
  accounts = { alice: profile('alice'), bob: profile('bob'), carol: profile('carol') }
  conversationId = localId('cnv')
  otherConversationId = localId('cnv')
  for (const account of Object.values(accounts)) {
    auth.tokens.set(account.user_id, randomBytes(32).toString('base64url'))
  }
  const pairs = [
    { id: conversationId, members: [accounts.alice, accounts.bob] },
    { id: otherConversationId, members: [accounts.alice, accounts.carol] },
  ]
  await fs.writeFile(fixtureFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: Object.values(accounts).map(account => ({
      id: account.user_id, email: `${account.username}@synthetic.example`, password_hash: '', created_at: CREATED,
    })),
    sessions: [...auth.tokens].map(([userId, token]) => ({
      id: localId('ses'), user_id: userId,
      token_hash: createHash('sha256').update(token).digest('hex'),
      created_at: CREATED, expires_at: '2026-11-01T08:00:00.000Z',
    })),
    profiles: Object.values(accounts),
    conversations: pairs.map(pair => ({
      id: pair.id, type: 'direct', title: null, created_at: CREATED,
      last_message_at: null, last_message_preview: null,
    })),
    conversation_participants: pairs.flatMap(pair => pair.members.map(account => ({
      id: localId('par'), conversation_id: pair.id, profile_id: account.id, last_read_at: null,
    }))),
    message_memberships: pairs.flatMap(pair => pair.members.map(account => ({
      conversation_id: pair.id, profile_id: account.id, joined_at: JOIN, left_at: null,
    }))),
    notifications: [], messages: [], notification_preferences: [],
  }))
  // Date only: the filesystem lock continues to use real retry timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(DURING)
  as('alice')
})

afterEach(async () => {
  auth.tokens.clear()
  auth.cookieOverride = undefined
  auth.userId = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const owned = workspace
  workspace = undefined
  await owned?.cleanup()
})

describe('atomic, bodyless local message activity', () => {
  it('delivers to the recipient profile, not the sender/user ID, and dedupes only the exact cloud activity key', async () => {
    const unrelated = activity({ post_id: localId('pst'), body: 'Synthetic unrelated key' })
    await seedFixture(db => { db.notifications.push(unrelated) })
    expect((await send('Synthetic private DM body')).status).toBe('success')
    const saved = await readStore()
    expect(saved.notifications).toHaveLength(2)
    expect(saved.notifications.find(row => row.id === unrelated.id)).toEqual(unrelated)
    const delivered = saved.notifications.find(row => row.id !== unrelated.id)!
    expect(delivered).toMatchObject({
      recipient_id: accounts.bob.id, actor_id: accounts.alice.id, type: 'message',
      conversation_id: conversationId, body: null, is_read: false, created_at: DURING,
      post_id: null, comment_id: null, project_id: null, idea_id: null,
      event_id: null, opportunity_id: null,
    })
    expect(delivered.recipient_id).not.toBe(accounts.bob.user_id)
    expect(saved.notifications.some(row => row.recipient_id === accounts.alice.id)).toBe(false)
    expect(JSON.stringify(saved.notifications)).not.toContain('Synthetic private DM body')
    expect(saved.mutation_limit_windows).toEqual([expect.objectContaining({
      bucket: 'message:write', subject: accounts.alice.user_id, hits: 1,
    })])
  })

  it('does not resurface an acknowledged nonce retry; a new nonce resurfaces the same bodyless row', async () => {
    const clientNonce = randomUUID()
    expect((await send('Synthetic accepted once', clientNonce)).status).toBe('success')
    const first = (await readStore()).notifications[0]
    as('bob')
    await markOneReadAction(form({ id: first.id }))
    const acknowledged = (await readStore()).notifications[0]
    expect(acknowledged.is_read).toBe(true)
    as('alice')
    vi.setSystemTime('2026-10-31T09:31:00.000Z')
    expect((await send('Synthetic accepted once', clientNonce)).status).toBe('success')
    expect((await readStore()).notifications).toEqual([acknowledged])
    expect((await send('Synthetic changed body same nonce', clientNonce)).status).toBe('error')
    expect((await readStore()).notifications).toEqual([acknowledged])

    expect((await send('Synthetic genuinely new send')).status).toBe('success')
    const saved = await readStore()
    expect(saved.messages).toHaveLength(2)
    expect(saved.notifications).toEqual([{
      ...acknowledged, is_read: false, created_at: '2026-10-31T09:31:00.000Z', body: null,
    }])
    expect(saved.mutation_limit_windows.reduce((sum, row) => sum + row.hits, 0)).toBe(2)
  })

  it('serializes identical in-flight retries into one message, one activity and one budget charge', async () => {
    const clientNonce = randomUUID()
    const results = await Promise.all([
      send('Synthetic concurrent local retry', clientNonce),
      send('Synthetic concurrent local retry', clientNonce),
    ])
    expect(results.map(row => row.status)).toEqual(['success', 'success'])
    const saved = await readStore()
    expect(saved.messages).toHaveLength(1)
    expect(saved.notifications).toHaveLength(1)
    expect(saved.notifications[0].body).toBeNull()
    expect(saved.mutation_limit_windows).toEqual([expect.objectContaining({
      bucket: 'message:write', subject: accounts.alice.user_id, hits: 1,
    })])
  })

  it('keeps actor/recipient/conversation keys separate and rejects sender nonce reuse in another thread', async () => {
    const clientNonce = randomUUID()
    await send('Synthetic first conversation', clientNonce)
    const first = (await readStore()).notifications[0]
    expect((await send('Synthetic wrong conversation retry', clientNonce, otherConversationId)).status).toBe('error')
    expect((await readStore()).notifications).toEqual([first])
    expect((await send('Synthetic separate recipient', randomUUID(), otherConversationId)).status).toBe('success')
    as('bob')
    expect((await send('Synthetic reverse-direction send')).status).toBe('success')
    expect((await readStore()).notifications.map(row => [
      row.recipient_id, row.actor_id, row.conversation_id,
    ])).toEqual([
      [accounts.bob.id, accounts.alice.id, conversationId],
      [accounts.carol.id, accounts.alice.id, otherConversationId],
      [accounts.alice.id, accounts.bob.id, conversationId],
    ])
  })

  it('rolls back a new message AND a proposed notification resurface when the mandatory budget refuses', async () => {
    await send('Synthetic prior accepted activity')
    const notice = (await readStore()).notifications[0]
    as('bob')
    await markOneReadAction(form({ id: notice.id }))
    as('alice')
    const policy = RATE_LIMITS['message:write']
    const start = Math.floor(Date.now() / (policy.windowSeconds * 1000)) * policy.windowSeconds * 1000
    await seedFixture(db => {
      db.mutation_limit_windows[0].hits = policy.limit
    })
    vi.setSystemTime(start + 1_000)
    const bytes = await fs.readFile(fixtureFile, 'utf8')
    const clientNonce = randomUUID()
    const refused = await send('Synthetic budget-refused private body', clientNonce)
    expect(refused).toMatchObject({
      status: 'error', values: { conversationId, body: 'Synthetic budget-refused private body', clientNonce },
    })
    expect(refused.message).toContain('Nothing from this attempt was saved.')
    expect(await fs.readFile(fixtureFile, 'utf8')).toBe(bytes)
    expect((await readStore()).messages).toHaveLength(1)
    expect((await readStore()).notifications[0]).toMatchObject({ id: notice.id, is_read: true, created_at: DURING })
  })

  it('does not commit message, notification or budget state after an unexpected atomic-rename failure', async () => {
    const bytes = await fs.readFile(fixtureFile, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic activity commit failed'))
    await expect(send('Synthetic failed private commit')).rejects.toThrow('Synthetic activity commit failed')
    expect(await fs.readFile(fixtureFile, 'utf8')).toBe(bytes)
    const saved = await readStore()
    expect(saved.messages).toEqual([])
    expect(saved.notifications).toEqual([])
    expect(saved.mutation_limit_windows).toEqual([])
  })
})

describe('notification consent, mute and ownership', () => {
  it('mute suppresses activity but not messages/unread; unmuting never delivers a previously accepted retry', async () => {
    as('bob')
    expect(await setConversationMutedAction(conversationId, true)).toMatchObject({ ok: true, muted: true })
    as('alice')
    const mutedNonce = randomUUID()
    expect((await send('Synthetic muted but readable send', mutedNonce)).status).toBe('success')
    expect((await readStore()).notifications).toEqual([])
    as('bob')
    expect(await getConversationPane(conversationId, accounts.bob.user_id)).toMatchObject({ unread_count: 1, is_muted: true })
    expect(await getTotalUnreadMessages()).toBe(0)
    expect((await listThreadMessages({ conversationId })).messages?.[0].body).toBe('Synthetic muted but readable send')
    expect(await setConversationMutedAction(conversationId, false)).toMatchObject({ ok: true, muted: false })
    as('alice')
    expect((await send('Synthetic muted but readable send', mutedNonce)).status).toBe('success')
    expect((await readStore()).notifications).toEqual([])
    vi.setSystemTime('2026-10-31T09:31:00.000Z')
    expect((await send('Synthetic future unmuted send')).status).toBe('success')
    expect((await readStore()).notifications).toHaveLength(1)
    as('bob')
    expect(await getConversationPane(conversationId, accounts.bob.user_id)).toMatchObject({ unread_count: 2, is_muted: false })
  })

  it('a muted new send leaves an existing read notification unchanged', async () => {
    await send('Synthetic before mute')
    const notice = (await readStore()).notifications[0]
    as('bob')
    await markOneReadAction(form({ id: notice.id }))
    await setConversationMutedAction(conversationId, true)
    const acknowledged = (await readStore()).notifications[0]
    as('alice')
    vi.setSystemTime('2026-10-31T09:31:00.000Z')
    await send('Synthetic while muted')
    expect((await readStore()).notifications).toEqual([acknowledged])
    expect((await readStore()).messages).toHaveLength(2)
  })

  it.each(['missing', 'enabled', 'disabled', 'unrelated'] as const)(
    'honors the messages category preference with missing-row-is-enabled (%s)',
    async setting => {
      if (setting !== 'missing') await seedFixture(db => {
        db.notification_preferences.push({
          profile_id: accounts.bob.id, category: setting === 'unrelated' ? 'posts' : 'messages',
          in_app_enabled: setting === 'enabled',
        })
      })
      expect((await send('Synthetic notification preference send')).status).toBe('success')
      expect((await readStore()).notifications).toHaveLength(setting === 'disabled' ? 0 : 1)
      as('bob')
      expect(await getConversationPane(conversationId, accounts.bob.user_id)).toMatchObject({ unread_count: 1 })
    },
  )

  it.each(['nobody', 'blocked-by-recipient', 'blocked-by-sender', 'left', 'disabled', 'suspended'] as const)(
    'does not deliver or resurface after current incoming consent is refused (%s)',
    async denial => {
      const clientNonce = randomUUID()
      await send('Synthetic accepted before consent changed', clientNonce)
      await seedFixture(db => {
        if (denial === 'nobody') db.profiles.find(row => row.id === accounts.bob.id)!.allow_messages_from = 'nobody'
        if (denial.startsWith('blocked')) db.blocks.push({
          id: localId('blk'),
          blocker_id: denial === 'blocked-by-recipient' ? accounts.bob.id : accounts.alice.id,
          blocked_id: denial === 'blocked-by-recipient' ? accounts.alice.id : accounts.bob.id,
          reason: null, created_at: DURING,
        })
        if (denial === 'left') db.message_memberships.find(row =>
          row.conversation_id === conversationId && row.profile_id === accounts.bob.id,
        )!.left_at = DURING
        if (denial === 'disabled') db.users.find(row => row.id === accounts.bob.user_id)!.disabled_at = DURING
        if (denial === 'suspended') db.profile_account_states.push({
          id: localId('state'), profile_id: accounts.bob.id, status: 'suspended',
          suspended_until: null, warning_count: 0,
        })
      })
      const before = await readStore()
      vi.setSystemTime(LEAVE)
      expect((await send('Synthetic denied incoming activity')).status).toBe('error')
      expect((await send('Synthetic accepted before consent changed', clientNonce)).status).toBe('error')
      expect((await readStore()).notifications).toEqual(before.notifications)
      expect((await readStore()).messages).toEqual(before.messages)
      expect((await readStore()).mutation_limit_windows).toEqual(before.mutation_limit_windows)
    },
  )

  it('keeps old activity/history after Nobody, and permits outbound sends according to the other recipient', async () => {
    await send('Synthetic readable old DM')
    await seedFixture(db => { db.profiles.find(row => row.id === accounts.bob.id)!.allow_messages_from = 'nobody' })
    as('bob')
    const history = await getNotifications()
    expect(history.notifications).toHaveLength(1)
    const { index } = await getTargetIndex(history.notifications!)
    expect(resolveTarget(history.notifications![0], index).target?.href).toBe(`/messages?c=${conversationId}`)
    expect((await listThreadMessages({ conversationId })).messages?.[0].body).toBe('Synthetic readable old DM')
    expect((await send('Synthetic outbound while incoming disabled')).status).toBe('success')
    const delivered = (await readStore()).notifications.find(row => row.recipient_id === accounts.alice.id)
    expect(delivered).toMatchObject({ actor_id: accounts.bob.id, body: null, conversation_id: conversationId })
  })

  it('notifies an existing consented private-profile DM without requiring profile publication', async () => {
    await seedFixture(db => { db.profiles.find(row => row.id === accounts.bob.id)!.visibility = 'private' })
    expect((await send('Synthetic existing private-profile DM')).status).toBe('success')
    expect((await readStore()).notifications[0]).toMatchObject({ recipient_id: accounts.bob.id, body: null })
  })

  it('notification reads and mark-one/mark-all remain recipient-owned', async () => {
    await send('Synthetic recipient-owned notification')
    const notice = (await readStore()).notifications[0]
    expect((await getNotifications()).notifications).toEqual([])
    expect(await getUnreadNotificationCount()).toBe(0)
    await markOneReadAction(form({ id: notice.id }))
    expect((await readStore()).notifications[0].is_read).toBe(false)
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 0 })
    as('bob')
    expect((await getNotifications()).notifications?.map(row => row.id)).toEqual([notice.id])
    expect(await getUnreadNotificationCount()).toBe(1)
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 1 })
    expect(await getUnreadNotificationCount()).toBe(0)
  })
})

describe('retained activity links and cutoff-safe notification reads', () => {
  it('keeps pre-leave group activity linked, sends nothing new to departed recipients, and excludes legacy post-T unread/body payloads', async () => {
    await makeGroup()
    await seedFixture(db => { db.profiles.find(row => row.id === accounts.bob.id)!.allow_messages_from = 'nobody' })
    await send('Synthetic valid group history')
    const old = (await readStore()).notifications.find(row => row.recipient_id === accounts.bob.id)!
    expect(old.body).toBeNull()
    as('bob')
    vi.setSystemTime(LEAVE)
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: true, left: true })
    as('alice')
    vi.setSystemTime(GAP)
    expect((await send('Synthetic private post-departure group body')).status).toBe('success')
    const saved = await readStore()
    expect(saved.notifications.filter(row => row.recipient_id === accounts.bob.id)).toEqual([old])
    expect(saved.notifications.find(row => row.recipient_id === accounts.carol.id)?.created_at).toBe(GAP)

    const after = activity({ created_at: GAP, body: 'Synthetic leaked post-T legacy notification' })
    const before = activity({ created_at: CREATED, body: 'Synthetic pre-join notification' })
    const invalid = activity({ created_at: 'invalid', body: 'Synthetic invalid instant' })
    await seedFixture(db => {
      db.notifications.find(row => row.id === old.id)!.body = 'Synthetic legacy private body must be scrubbed'
      db.notifications.push(after, before, invalid)
    })
    as('bob')
    const notifications = (await getNotifications()).notifications!
    expect(notifications.map(row => row.id)).toEqual([old.id])
    expect(notifications[0].body).toBeNull()
    expect(await getUnreadNotificationCount()).toBe(1)
    const { index } = await getTargetIndex(notifications)
    const view = toNotificationView(notifications[0], index)
    expect(view.target).toEqual({ href: `/messages?c=${conversationId}`, label: 'Open the conversation' })
    expect(view.detail).toBeNull()
    expect((await getTargetIndex([rowOf(after)])).index.conversations.size).toBe(0)
    expect((await listThreadMessages({ conversationId })).messages?.map(row => row.body)).toEqual(['Synthetic valid group history'])
    expect(await getTotalUnreadMessages()).toBe(0)
    expect(JSON.stringify({ notifications, view })).not.toMatch(/private body|post-T|pre-join/)
  })

  it('uses inclusive joined/left instants but rejects the following millisecond and unrelated conversation targets', async () => {
    const atJoin = activity({ created_at: JOIN })
    const atLeave = activity({ created_at: LEAVE })
    const after = activity({ created_at: '2026-10-31T10:00:00.001Z' })
    const foreign = activity({ conversation_id: otherConversationId, created_at: DURING })
    await seedFixture(db => { db.notifications.push(atJoin, atLeave, after, foreign) })
    as('bob')
    vi.setSystemTime(LEAVE)
    await leaveConversationAction(conversationId)
    expect((await getNotifications()).notifications?.map(row => row.id)).toEqual([atLeave.id, atJoin.id])
    expect(await getUnreadNotificationCount()).toBe(2)
    const db = await readStore()
    expect(canReadConversationActivityLocal(db, conversationId, JOIN, accounts.bob)).toBe(true)
    expect(canReadConversationActivityLocal(db, conversationId, LEAVE, accounts.bob)).toBe(true)
    expect(canReadConversationActivityLocal(db, conversationId, after.created_at, accounts.bob)).toBe(false)
    expect((await getTargetIndex([rowOf(foreign)])).index.conversations.size).toBe(0)
  })

  it('a real explicit rejoin does not reveal gap notifications, messages, edited bodies or report-target contents', async () => {
    await send('Synthetic valid first membership body')
    as('bob')
    vi.setSystemTime(LEAVE)
    await leaveConversationAction(conversationId)
    const gapNotice = activity({ created_at: GAP, body: 'Synthetic absence private notification' })
    const gapMessageId = localId('msg')
    const editedMessageId = localId('msg')
    await seedFixture(db => {
      db.notifications.push(gapNotice)
      db.messages.push({
        id: gapMessageId, conversation_id: conversationId, author_id: accounts.alice.id,
        body: 'Synthetic absence private message', created_at: GAP,
      })
      db.messages.push(Object.assign({
        id: editedMessageId, conversation_id: conversationId, author_id: accounts.alice.id,
        body: 'Synthetic post-T edit private body', created_at: DURING,
      }, { edited_at: GAP }))
    })
    vi.setSystemTime(REJOIN)
    await expect(startConversationAction({ status: 'idle' }, form({
      username: accounts.alice.username,
    }))).rejects.toThrow(`redirect:/messages?c=${conversationId}`)
    as('alice')
    vi.setSystemTime('2026-10-31T11:01:00.000Z')
    await send('Synthetic valid fresh membership body')
    as('bob')
    const notifications = (await getNotifications()).notifications!
    expect(notifications).toHaveLength(1)
    expect(notifications[0].id).not.toBe(gapNotice.id)
    expect(notifications[0].created_at).toBe('2026-10-31T11:01:00.000Z')
    expect((await getTargetIndex([rowOf(gapNotice)])).index.conversations.size).toBe(0)
    const thread = await listThreadMessages({ conversationId })
    expect(thread.messages?.map(row => row.body)).toEqual([
      'Synthetic valid first membership body', 'Synthetic valid fresh membership body',
    ])
    const db = await readStore() as Fixture
    expect(messageReportTargetLocal(db, gapMessageId, accounts.bob)).toBeNull()
    expect(messageReportTargetLocal(db, editedMessageId, accounts.bob)).toBeNull()
    expect(canReadConversationActivityLocal(db, conversationId, GAP, accounts.bob)).toBe(false)
    expect(db.message_memberships.filter(row => row.profile_id === accounts.bob.id)
      .map(row => [row.joined_at, row.left_at])).toEqual([[JOIN, LEAVE], [REJOIN, null]])
    expect(JSON.stringify({ notifications, thread })).not.toContain('private')
  })

  it('scrubs message detail even for a legacy/hosted-shaped row bypassing the local query', () => {
    const notice = rowOf(activity({ body: 'Synthetic legacy private preview' }))
    const index = emptyTargetIndex()
    index.conversations = new Set([conversationId])
    expect(toNotificationView(notice, index)).toMatchObject({
      detail: null, target: { href: `/messages?c=${conversationId}`, label: 'Open the conversation' },
    })
    expect(toNotificationView({ ...notice, type: 'content_hidden', conversation_id: null }, emptyTargetIndex()).detail)
      .toBe('Synthetic legacy private preview')
  })

  it('scrubs unexpected hosted message bodies before returning query DTOs, retaining non-message detail', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    const notice = rowOf(activity({ body: 'Synthetic hosted private message body' }))
    const moderation = { ...notice, id: localId('ntf'), type: 'content_hidden', body: 'Synthetic moderation note' }
    const query = {
      select: vi.fn(), order: vi.fn(), limit: vi.fn(),
      returns: vi.fn(async () => ({ data: [notice, moderation], error: null })),
    }
    query.select.mockReturnValue(query)
    query.order.mockReturnValue(query)
    query.limit.mockReturnValue(query)
    auth.createClient.mockResolvedValue({ from: vi.fn(() => query) })
    const result = await getNotifications()
    expect(result.notifications?.map(row => row.body)).toEqual([null, 'Synthetic moderation note'])
    expect(JSON.stringify(result)).not.toContain('Synthetic hosted private message body')
  })

  it.each([true, false])('resolves hosted history targets through the caller-scoped summary, not raw previews (readable=%s)', async readable => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    const notice = rowOf(activity())
    const query = {
      select: vi.fn(), in: vi.fn(),
      returns: vi.fn(async () => ({ data: readable ? [{ id: conversationId }] : [], error: null })),
    }
    query.select.mockReturnValue(query)
    query.in.mockReturnValue(query)
    const from = vi.fn((table: string) => {
      if (table !== 'message_conversation_summaries') throw new Error('Raw conversation target lookup is not cutoff-safe')
      return query
    })
    auth.createClient.mockResolvedValue({ from })
    const { index, error } = await getTargetIndex([notice])
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('message_conversation_summaries')
    expect(query.select).toHaveBeenCalledWith('id')
    expect(query.in).toHaveBeenCalledWith('id', [conversationId])
    expect(error).toBeNull()
    expect(index.conversations.has(conversationId)).toBe(readable)
    expect(resolveTarget(notice, index)).toEqual(readable
      ? { target: { href: `/messages?c=${conversationId}`, label: 'Open the conversation' }, unavailable: false }
      : { target: null, unavailable: true })
  })
})

describe('real cookie/session guards remain mandatory for notification-producing sends', () => {
  it.each(['missing', 'malformed', 'unknown', 'expired', 'revoked'] as const)(
    'rejects a %s session, including stale getUser preauthorization, without any delivery',
    async state => {
      await send('Synthetic existing recipient notification')
      if (state === 'missing') auth.cookieOverride = null
      if (state === 'malformed') auth.cookieOverride = 'not-a-session-token'
      if (state === 'unknown') auth.cookieOverride = randomBytes(32).toString('base64url')
      if (state === 'expired') await seedFixture(db => {
        db.sessions.find(row => row.user_id === accounts.alice.user_id)!.expires_at = DURING
      })
      if (state === 'revoked') await seedFixture(db => {
        db.sessions = db.sessions.filter(row => row.user_id !== accounts.alice.user_id)
      })
      const bytes = await fs.readFile(fixtureFile, 'utf8')
      expect((await send('Synthetic unverified incoming body')).status).toBe('error')
      expect((await getNotifications()).notifications).toEqual([])
      expect(await getUnreadNotificationCount()).toBe(0)
      await markOneReadAction(form({ id: (await readStore()).notifications[0].id }))
      expect(await fs.readFile(fixtureFile, 'utf8')).toBe(bytes)
      auth.getUser.mockResolvedValueOnce({ id: accounts.alice.user_id })
      await expect(send('Synthetic stale authorization send')).rejects.toThrow(/verified session user/)
      expect(await fs.readFile(fixtureFile, 'utf8')).toBe(bytes)
    },
  )
})
