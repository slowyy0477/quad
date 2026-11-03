import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({
  userId: 'usr_bob' as string | null,
  tokens: new Map<string, string>(),
  cookieOverride: undefined as string | null | undefined,
  getUser: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: auth.getUser,
  createClient: () => { throw new Error('Isolated local message test reached Supabase') },
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

import { mutate, readStore, resetLocalCache, type Tables } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { RATE_LIMITS } from '@/lib/rate-limit/budgets'
import {
  leaveConversationAction,
  markConversationReadAction,
  sendMessageAction,
  setConversationMutedAction,
  startConversationAction,
} from '@/features/messages/actions'
import {
  getConversationPane,
  getTotalUnreadMessages,
  listConversations,
  listThreadMessages,
} from '@/features/messages/queries'
import {
  canReadMessageLocal,
  messageReportTargetLocal,
  type MessageMembership,
} from '@/features/messages/local-access'

const CREATED = '2026-10-31T08:00:00.000Z'
const JOIN = '2026-10-31T09:00:00.000Z'
const DURING = '2026-10-31T09:30:00.000Z'
const LEAVE = '2026-10-31T10:00:00.000Z'
const GAP = '2026-10-31T10:30:00.000Z'
const REJOIN = '2026-10-31T11:00:00.000Z'
const NONCE = '11111111-1111-4111-8111-111111111111'
let workspace: TempWorkspace | undefined

function form(values: Record<string, string>) {
  const result = new FormData()
  for (const [name, value] of Object.entries(values)) result.set(name, value)
  return result
}

function profile(name: string) {
  return {
    id: `prf_${name}`, user_id: `usr_${name}`, username: name, display_name: name,
    bio: null, avatar_url: null, university_id: 'uni_one', department: null,
    programme: null, semester: null, website: null, github: null,
    visibility: 'public', searchable: true, allow_messages_from: 'everyone', created_at: CREATED,
  }
}

beforeEach(async () => {
  resetLocalCache()
  auth.tokens.clear()
  auth.cookieOverride = undefined
  auth.getUser.mockReset()
  // Use the real session reader for actions and reads. db.mutate independently
  // verifies the same cookie against its locked snapshot before committing.
  auth.getUser.mockImplementation(async () => (await import('@/lib/local/session')).getLocalUser())
  workspace = await createTempWorkspace('message-privacy')
  const dataPath = path.join(workspace.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', dataPath)
  for (const name of ['alice', 'bob', 'carol']) {
    auth.tokens.set(`usr_${name}`, randomBytes(32).toString('base64url'))
  }
  await fs.writeFile(dataPath, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: ['alice', 'bob', 'carol'].map(name => ({
      id: `usr_${name}`, email: `${name}@synthetic.example`, password_hash: '', created_at: CREATED,
    })),
    sessions: [...auth.tokens].map(([userId, token]) => ({
      id: `ses_${userId}`,
      user_id: userId,
      token_hash: createHash('sha256').update(token).digest('hex'),
      created_at: CREATED,
      expires_at: '2026-11-01T08:00:00.000Z',
    })),
    profiles: ['alice', 'bob', 'carol'].map(profile),
    conversations: [{
      id: 'cnv_one', type: 'group', title: 'Synthetic group', created_at: CREATED,
      last_message_at: DURING, last_message_preview: 'synthetic valid history',
    }],
    conversation_participants: ['alice', 'bob', 'carol'].map(name => ({
      id: `par_${name}`, conversation_id: 'cnv_one', profile_id: `prf_${name}`, last_read_at: null,
    })),
    message_memberships: ['alice', 'bob', 'carol'].map(name => ({
      conversation_id: 'cnv_one', profile_id: `prf_${name}`, joined_at: JOIN, left_at: null,
    })),
    messages: [
      { id: 'msg_prejoin', conversation_id: 'cnv_one', author_id: 'prf_alice', body: 'synthetic prejoin secret', created_at: CREATED },
      { id: 'msg_during', conversation_id: 'cnv_one', author_id: 'prf_alice', body: 'synthetic valid history', created_at: DURING },
    ],
  }))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(LEAVE)
  auth.userId = 'usr_bob'
})

afterEach(async () => {
  auth.tokens.clear()
  auth.cookieOverride = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const owned = workspace
  workspace = undefined
  await owned?.cleanup()
})

/** Privileged setup touches only this test's owned file, never the commit hook. */
async function seedFixture(change: (db: Tables) => void) {
  if (!workspace) throw new Error('No owned messaging fixture')
  const snapshot = await readStore()
  change(snapshot)
  await fs.writeFile(path.join(workspace.directory, 'local.json'), JSON.stringify(snapshot, null, 2), 'utf8')
}

async function leaveAndSendGap() {
  expect(await leaveConversationAction('cnv_one')).toEqual({ ok: true, left: true })
  auth.userId = 'usr_alice'
  vi.setSystemTime(GAP)
  expect((await sendMessageAction({ status: 'idle' }, form({
    conversationId: 'cnv_one', body: 'synthetic postleave secret',
  }))).status).toBe('success')
  auth.userId = 'usr_bob'
}

async function makeDirect() {
  await seedFixture(db => {
    db.conversations[0].type = 'direct'
    db.conversations[0].title = null
    db.conversation_participants = db.conversation_participants.filter(row => row.profile_id !== 'prf_carol')
  })
}

describe('isolated local retained-history reads', () => {
  it('retains membership history, excludes prejoin/postleave content, and exposes no future activity/unread', async () => {
    await leaveAndSendGap()
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages?.map(row => row.id)).toEqual(['msg_during'])
    const summary = (await listConversations({ meId: 'usr_bob' })).conversations?.[0]
    expect(summary).toMatchObject({
      left: true, unread_count: 0, last_message_at: DURING,
      last_message_preview: 'synthetic valid history', last_activity_at: DURING,
    })
    expect(await getConversationPane('cnv_one', 'usr_bob')).toMatchObject({ left: true, unread_count: 0 })
    expect(await getTotalUnreadMessages()).toBe(0)
    expect(await markConversationReadAction('cnv_one')).toMatchObject({ ok: false })
    const db = await readStore()
    const me = db.profiles.find(row => row.id === 'prf_bob')!
    expect(messageReportTargetLocal(db, 'msg_during', me)?.body).toBe('synthetic valid history')
    expect(messageReportTargetLocal(db, 'msg_prejoin', me)).toBeNull()
    expect(messageReportTargetLocal(db, db.messages.at(-1)!.id, me)).toBeNull()
    expect(JSON.stringify(await listThreadMessages({ conversationId: 'cnv_one' }))).not.toContain('secret')
  })

  it('keeps inclusive boundaries without granting the following instant', async () => {
    await seedFixture(db => {
      db.messages.push(
        { id: 'msg_join', conversation_id: 'cnv_one', author_id: 'prf_alice', body: 'exact join', created_at: JOIN },
        { id: 'msg_left', conversation_id: 'cnv_one', author_id: 'prf_alice', body: 'exact leave', created_at: LEAVE },
        { id: 'msg_later', conversation_id: 'cnv_one', author_id: 'prf_alice', body: 'too late', created_at: '2026-10-31T10:00:00.001Z' },
      )
    })
    await leaveConversationAction('cnv_one')
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages?.map(row => row.id)).toEqual([
      'msg_join', 'msg_during', 'msg_left',
    ])
  })

  it('fails closed if legacy preference clearing attempts to reopen a recorded departure', async () => {
    await leaveAndSendGap()
    await seedFixture(db => { db.participant_preferences.find(row => row.profile_id === 'prf_bob')!.left_at = null })
    expect(await getConversationPane('cnv_one', 'usr_bob')).toMatchObject({ left: true, unread_count: 0 })
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages?.map(row => row.id)).toEqual(['msg_during'])
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'cannot rejoin by clearing a flag',
    }))).status).toBe('error')
  })

  it('allows explicit caller rejoin but not absence content, and resets only their unread interval', async () => {
    await leaveAndSendGap()
    await makeDirect()
    vi.setSystemTime(REJOIN)
    await expect(startConversationAction({ status: 'idle' }, form({ username: 'alice' }))).rejects.toThrow('redirect:/messages?c=cnv_one')
    auth.userId = 'usr_alice'
    vi.setSystemTime('2026-10-31T11:01:00.000Z')
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'synthetic fresh membership message',
    }))).status).toBe('success')
    auth.userId = 'usr_bob'
    const messages = (await listThreadMessages({ conversationId: 'cnv_one' })).messages!
    expect(messages.map(row => row.body)).toEqual(['synthetic valid history', 'synthetic fresh membership message'])
    expect(await getTotalUnreadMessages()).toBe(1)
    const db = await readStore()
    const me = db.profiles.find(row => row.id === 'prf_bob')!
    expect(messageReportTargetLocal(db, db.messages.find(row => row.body === 'synthetic postleave secret')!.id, me)).toBeNull()
    const memberships = (db as typeof db & { message_memberships: MessageMembership[] }).message_memberships
      .filter(row => row.profile_id === 'prf_bob')
    expect(memberships.map(row => [row.joined_at, row.left_at])).toEqual([[JOIN, LEAVE], [REJOIN, null]])
  })

  it('does not expose edited post-departure text or stale shared previews', async () => {
    await leaveAndSendGap()
    await seedFixture(db => {
      Object.assign(db.messages.find(row => row.id === 'msg_during')!, {
        body: 'synthetic edit secret', edited_at: GAP,
      })
    })
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages).toEqual([])
    expect((await listConversations({ meId: 'usr_bob' })).conversations?.[0].last_message_preview).toBeNull()
    expect(await getTotalUnreadMessages()).toBe(0)
  })

  it('paginates only readable membership windows without reaching a prejoin or absence message', async () => {
    await leaveAndSendGap()
    await makeDirect()
    vi.setSystemTime(REJOIN)
    await expect(startConversationAction({ status: 'idle' }, form({ username: 'alice' }))).rejects.toThrow('redirect:/messages?c=cnv_one')
    auth.userId = 'usr_alice'
    vi.setSystemTime('2026-10-31T11:01:00.000Z')
    await sendMessageAction({ status: 'idle' }, form({ conversationId: 'cnv_one', body: 'newest permitted message' }))
    auth.userId = 'usr_bob'
    const first = await listThreadMessages({ conversationId: 'cnv_one', limit: 1 })
    expect(first.messages?.[0].body).toBe('newest permitted message')
    const cursor = Buffer.from(`${first.olderCursor!.createdAt}|${first.olderCursor!.id}`).toString('base64url')
    const older = await listThreadMessages({ conversationId: 'cnv_one', limit: 1, cursor })
    expect(older.messages?.map(row => row.id)).toEqual(['msg_during'])
    const end = Buffer.from(`${older.olderCursor!.createdAt}|${older.olderCursor!.id}`).toString('base64url')
    expect((await listThreadMessages({ conversationId: 'cnv_one', limit: 1, cursor: end })).messages).toEqual([])
  })

  it('archives a legacy preference-only departure before explicit rejoin clears that flag', async () => {
    await seedFixture(db => { db.participant_preferences.push({
      id: 'pref_bob', conversation_id: 'cnv_one', profile_id: 'prf_bob', is_muted: false, left_at: LEAVE,
    }) })
    auth.userId = 'usr_alice'
    vi.setSystemTime(GAP)
    await sendMessageAction({ status: 'idle' }, form({ conversationId: 'cnv_one', body: 'legacy absence secret' }))
    await makeDirect()
    auth.userId = 'usr_bob'
    vi.setSystemTime(REJOIN)
    await expect(startConversationAction({ status: 'idle' }, form({ username: 'alice' }))).rejects.toThrow('redirect:/messages?c=cnv_one')
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages?.map(row => row.id)).toEqual(['msg_during'])
    const db = await readStore()
    const past = (db as typeof db & { message_memberships: MessageMembership[] }).message_memberships
      .find(row => row.profile_id === 'prf_bob' && row.joined_at === JOIN)
    expect(past?.left_at).toBe(LEAVE)
  })

  it('keeps legacy rows readable within their recorded lower bound without modifying them on reads', async () => {
    await seedFixture(db => {
      delete (db as typeof db & { message_memberships?: MessageMembership[] }).message_memberships
      db.participant_preferences.push({
        id: 'pref_bob', conversation_id: 'cnv_one', profile_id: 'prf_bob', is_muted: false, left_at: LEAVE,
      })
    })
    const before = await readStore()
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages).toHaveLength(2)
    expect(await readStore()).toEqual(before)
  })

  it('rejects session/profile substitution, strangers, and signed-out read/write calls', async () => {
    expect(await getConversationPane('cnv_one', 'usr_alice')).toBeNull()
    expect((await listConversations({ meId: 'usr_alice' })).conversations).toEqual([])
    auth.userId = 'usr_carol'
    await seedFixture(db => { db.conversation_participants = db.conversation_participants.filter(row => row.profile_id !== 'prf_carol') })
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages).toBeNull()
    expect(await leaveConversationAction('cnv_one')).toMatchObject({ ok: false })
    auth.userId = null
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'anonymous send',
    }))).status).toBe('error')
    expect(await getTotalUnreadMessages()).toBe(0)
    const db = await readStore()
    expect(canReadMessageLocal(db, db.messages[0], null)).toBe(false)
  })

  it('preserves mute preferences through leaving and does not count future messages', async () => {
    expect(await setConversationMutedAction('cnv_one', true)).toMatchObject({ ok: true, muted: true })
    await leaveAndSendGap()
    expect(await getConversationPane('cnv_one', 'usr_bob')).toMatchObject({ left: true, is_muted: true, unread_count: 0 })
    expect(await setConversationMutedAction('cnv_one', false)).toMatchObject({ ok: true, muted: false })
    expect(await getTotalUnreadMessages()).toBe(0)
  })
})

describe('isolated local DM contract and retries', () => {
  it('stops new/existing incoming DMs after Nobody, retaining history and respecting outbound recipient consent', async () => {
    await makeDirect()
    await seedFixture(db => { db.profiles.find(row => row.id === 'prf_bob')!.allow_messages_from = 'nobody' })
    auth.userId = 'usr_alice'
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'must not arrive',
    }))).status).toBe('error')
    expect((await startConversationAction({ status: 'idle' }, form({ username: 'bob' }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages?.map(row => row.id)).toEqual(['msg_during'])
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'outgoing follows Alice preference',
    }))).status).toBe('success')
  })

  it.each(['university', 'connections'] as const)('rechecks %s on every existing send', async (preference) => {
    await makeDirect()
    await seedFixture(db => {
      const bob = db.profiles.find(row => row.id === 'prf_bob')!
      bob.allow_messages_from = preference
      bob.university_id = 'uni_other'
    })
    auth.userId = 'usr_alice'
    const send = () => sendMessageAction({ status: 'idle' }, form({ conversationId: 'cnv_one', body: 'synthetic preference send' }))
    expect((await send()).status).toBe('error')
    await seedFixture(db => {
      if (preference === 'university') db.profiles.find(row => row.id === 'prf_bob')!.university_id = 'uni_one'
      else db.connections.push({
        id: 'con_one', requester_id: 'prf_alice', addressee_id: 'prf_bob',
        status: 'accepted', message: null, created_at: CREATED, responded_at: CREATED,
      })
    })
    expect((await send()).status).toBe('success')
  })

  it.each(['alice', 'bob'] as const)('rejects either-way blocks created by %s', async (blocker) => {
    await makeDirect()
    await seedFixture(db => { db.blocks.push({
      id: 'blk_one', blocker_id: `prf_${blocker}`, blocked_id: blocker === 'alice' ? 'prf_bob' : 'prf_alice',
      reason: null, created_at: LEAVE,
    }) })
    for (const name of ['alice', 'bob']) {
      auth.userId = `usr_${name}`
      expect((await sendMessageAction({ status: 'idle' }, form({
        conversationId: 'cnv_one', body: 'must not cross block',
      }))).status).toBe('error')
      expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages).toBeNull()
    }
    expect((await readStore()).messages).toHaveLength(2)
  })

  it('does not silently re-add a departed recipient when the other person opens the same DM', async () => {
    await makeDirect()
    await leaveConversationAction('cnv_one')
    auth.userId = 'usr_alice'
    await expect(startConversationAction({ status: 'idle' }, form({ username: 'bob' }))).rejects.toThrow('redirect:/messages?c=cnv_one')
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'departed recipient',
    }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect(await getConversationPane('cnv_one', 'usr_bob')).toMatchObject({ left: true })
  })

  it('does not tie an existing consented DM to public profile visibility', async () => {
    await makeDirect()
    await seedFixture(db => { db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'private' })
    auth.userId = 'usr_alice'
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'private profile valid DM',
    }))).status).toBe('success')
    expect(await getConversationPane('cnv_one', 'usr_alice')).toMatchObject({ other: null })
  })

  it('keeps group preferences separate and rejects disabled recipients in direct chats', async () => {
    await seedFixture(db => { db.profiles.find(row => row.id === 'prf_bob')!.allow_messages_from = 'nobody' })
    auth.userId = 'usr_alice'
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'consented group send',
    }))).status).toBe('success')
    await makeDirect()
    await seedFixture(db => {
      db.profiles.find(row => row.id === 'prf_bob')!.allow_messages_from = 'everyone'
      db.users.find(row => row.id === 'usr_bob')!.disabled_at = LEAVE
    })
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'disabled recipient send',
    }))).status).toBe('error')
  })

  it('makes retries one message/unread and refuses nonce reuse for another body', async () => {
    await makeDirect()
    auth.userId = 'usr_alice'
    const same = form({ conversationId: 'cnv_one', body: 'synthetic retried send', clientNonce: NONCE })
    expect((await sendMessageAction({ status: 'idle' }, same)).status).toBe('success')
    expect((await sendMessageAction({ status: 'idle' }, same)).status).toBe('success')
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'changed body same nonce', clientNonce: NONCE,
    }))).status).toBe('error')
    const saved = await readStore()
    expect(saved.messages.filter(row => row.body === 'synthetic retried send')).toHaveLength(1)
    expect(saved.mutation_limit_windows).toEqual([expect.objectContaining({
      bucket: 'message:write', subject: 'usr_alice', hits: 1,
    })])
    auth.userId = 'usr_bob'
    expect(await getTotalUnreadMessages()).toBe(2)
  })

  it('serializes two in-flight local retries into one accepted durable send', async () => {
    await makeDirect()
    auth.userId = 'usr_alice'
    const send = () => sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'synthetic simultaneous local retry', clientNonce: NONCE,
    }))
    const results = await Promise.all([send(), send()])
    expect(results.map(row => row.status)).toEqual(['success', 'success'])
    const saved = await readStore()
    expect(saved.messages.filter(row => row.body === 'synthetic simultaneous local retry')).toHaveLength(1)
    expect(saved.mutation_limit_windows).toEqual([expect.objectContaining({
      bucket: 'message:write', subject: 'usr_alice', hits: 1,
    })])
  })

  it('rejects malformed retry identifiers and a replay after blocking without another delivery', async () => {
    await makeDirect()
    auth.userId = 'usr_alice'
    expect((await sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'invalid identifier', clientNonce: 'not-a-uuid',
    }))).status).toBe('error')
    const same = form({ conversationId: 'cnv_one', body: 'synthetic accepted once', clientNonce: NONCE })
    expect((await sendMessageAction({ status: 'idle' }, same)).status).toBe('success')
    await seedFixture(db => { db.blocks.push({
      id: 'blk_one', blocker_id: 'prf_bob', blocked_id: 'prf_alice', reason: null, created_at: LEAVE,
    }) })
    expect((await sendMessageAction({ status: 'idle' }, same)).status).toBe('error')
    expect((await readStore()).messages.filter(row => row.body === 'synthetic accepted once')).toHaveLength(1)
  })
})

describe('isolated local messaging sessions and mandatory budgets', () => {
  it.each(['missing', 'malformed', 'unknown', 'expired', 'revoked'] as const)(
    'rejects a %s session for reads/actions and protected writes, including stale preauthorization',
    async (state) => {
      if (state === 'missing') auth.cookieOverride = null
      if (state === 'malformed') auth.cookieOverride = 'not-a-session-token'
      if (state === 'unknown') auth.cookieOverride = randomBytes(32).toString('base64url')
      if (state === 'expired') await seedFixture(db => {
        db.sessions.find(row => row.user_id === 'usr_bob')!.expires_at = LEAVE
      })
      if (state === 'revoked') await seedFixture(db => {
        db.sessions = db.sessions.filter(row => row.user_id !== 'usr_bob')
      })
      const before = await readStore()
      expect((await listThreadMessages({ conversationId: 'cnv_one' })).messages).toBeNull()
      expect((await listConversations({ meId: 'usr_bob' })).conversations).toEqual([])
      expect(await getConversationPane('cnv_one', 'usr_bob')).toBeNull()
      expect(await getTotalUnreadMessages()).toBe(0)
      const send = () => sendMessageAction({ status: 'idle' }, form({
        conversationId: 'cnv_one', body: 'session must not authorize this message',
      }))
      expect((await send()).status).toBe('error')
      expect(await leaveConversationAction('cnv_one')).toMatchObject({ ok: false })
      expect(await markConversationReadAction('cnv_one')).toMatchObject({ ok: false })
      expect(await readStore()).toEqual(before)

      const bytes = await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')
      // A cached getUser result cannot bypass the locked cookie/session check.
      auth.getUser.mockResolvedValueOnce({ id: 'usr_bob' })
      await expect(send()).rejects.toThrow(/verified session user/)
      await expect(mutate(db => {
        db.messages.push({
          id: 'msg_unverified', conversation_id: 'cnv_one', author_id: 'prf_bob',
          body: 'direct protected write must fail closed', created_at: LEAVE,
        })
      })).rejects.toThrow(/verified session user/)
      expect(await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')).toBe(bytes)
    },
  )

  it('allows an exact nonce retry at capacity but atomically refuses a new send until the next window', async () => {
    await makeDirect()
    auth.userId = 'usr_alice'
    const { limit, windowSeconds } = RATE_LIMITS['message:write']
    const start = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000
    await seedFixture(db => {
      db.mutation_limit_windows.push({
        id: `message:write:usr_alice:${start}`, bucket: 'message:write', subject: 'usr_alice',
        window_start_ms: start, hits: limit - 1,
      })
    })
    const accepted = form({
      conversationId: 'cnv_one', body: 'synthetic last allowed send', clientNonce: NONCE,
    })
    expect((await sendMessageAction({ status: 'idle' }, accepted)).status).toBe('success')
    expect((await sendMessageAction({ status: 'idle' }, accepted)).status).toBe('success')
    const saved = await readStore()
    expect(saved.messages.filter(row => row.body === 'synthetic last allowed send')).toHaveLength(1)
    expect(saved.mutation_limit_windows).toEqual([expect.objectContaining({
      bucket: 'message:write', subject: 'usr_alice', hits: limit,
    })])
    const bytes = await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')
    const next = form({
      conversationId: 'cnv_one', body: 'synthetic next-window send',
      clientNonce: '22222222-2222-4222-8222-222222222222',
    })
    next.set('token', auth.tokens.get('usr_alice')!)
    const refused = await sendMessageAction({ status: 'idle' }, next)
    expect(refused).toMatchObject({
      status: 'error',
      values: {
        conversationId: 'cnv_one', body: 'synthetic next-window send',
        clientNonce: '22222222-2222-4222-8222-222222222222',
      },
    })
    expect(refused.message).toContain('Nothing from this attempt was saved.')
    expect(JSON.stringify(refused)).not.toContain(auth.tokens.get('usr_alice'))
    expect(await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')).toBe(bytes)
    vi.setSystemTime(start + windowSeconds * 1000)
    expect((await sendMessageAction({ status: 'idle' }, next)).status).toBe('success')
    expect((await readStore()).mutation_limit_windows.map(row => row.hits)).toEqual([limit, 1])
  })

  it('does not convert an unexpected storage failure into a budget refusal or commit any send', async () => {
    auth.userId = 'usr_alice'
    const bytes = await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic messaging commit failed'))
    await expect(sendMessageAction({ status: 'idle' }, form({
      conversationId: 'cnv_one', body: 'synthetic failed commit', clientNonce: NONCE,
    }))).rejects.toThrow('Synthetic messaging commit failed')
    expect(await fs.readFile(path.join(workspace!.directory, 'local.json'), 'utf8')).toBe(bytes)
  })
})
