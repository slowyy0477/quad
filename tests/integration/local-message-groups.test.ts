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
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== 'quad_local_session') return undefined
      const raw = auth.cookieOverride === undefined
        ? auth.userId && auth.tokens.get(auth.userId) : auth.cookieOverride
      return raw ? { value: raw } : undefined
    },
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: auth.getUser,
  createClient: () => { throw new Error('Local group test reached a hosted client') },
}))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { readStore, resetLocalCache, type LocalProfile, type Tables } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import {
  addGroupMembersAction,
  createGroupConversationAction,
  leaveConversationAction,
  removeGroupMemberAction,
  sendMessageAction,
  setGroupMemberRoleAction,
} from '@/features/messages/actions'
import { getConversationPane, listThreadMessages } from '@/features/messages/queries'
import { groupManagementPaneLocal } from '@/features/messages/local-groups'
import { FINAL_GROUP_ADMIN_COPY } from '@/features/messages/group-contract'
import { messageReportTargetLocal, type MessageMembership } from '@/features/messages/local-access'
import { RATE_LIMITS } from '@/lib/rate-limit/budgets'

type Name = 'alice' | 'bob' | 'carol'
type Fixture = Tables & { message_memberships?: MessageMembership[] }
const CREATED = '2026-10-31T08:00:00.000Z'
const JOIN = '2026-10-31T09:00:00.000Z'
const DURING = '2026-10-31T09:30:00.000Z'
const LEAVE = '2026-10-31T10:00:00.000Z'
const GAP = '2026-10-31T10:30:00.000Z'
const REJOIN = '2026-10-31T11:00:00.000Z'
let workspace: TempWorkspace | undefined
let fixtureFile: string
let accounts: Record<Name, LocalProfile>

function localId(prefix: string) { return `${prefix}_${randomBytes(10).toString('hex')}` }
function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}
function as(name: Name) { auth.userId = accounts[name].user_id }
function profile(name: Name): LocalProfile {
  return {
    id: localId('prf'), user_id: localId('usr'),
    username: `group_${name}_${randomBytes(4).toString('hex')}`,
    display_name: `Synthetic group ${name}`, bio: null, avatar_url: null,
    university_id: null, department: null, programme: null, semester: null,
    website: null, github: null, visibility: 'public', searchable: true,
    allow_messages_from: 'everyone', created_at: CREATED,
  }
}

/** Setup alone writes this isolated fixture; actions use the real locked store. */
async function seed(change: (db: Fixture) => void) {
  if (!workspace) throw new Error('Missing owned group fixture')
  const snapshot = await readStore() as Fixture
  change(snapshot)
  await fs.writeFile(fixtureFile, JSON.stringify(snapshot, null, 2), 'utf8')
}
async function connect(a: Name, b: Name) {
  await seed(db => { db.connections.push({
    id: localId('con'), requester_id: accounts[a].id, addressee_id: accounts[b].id,
    status: 'accepted', message: null, created_at: CREATED, responded_at: CREATED,
  }) })
}
function create(handles = accounts.bob.username) {
  return createGroupConversationAction({ status: 'idle' }, form({ title: 'Synthetic bounded group', handles }))
}
async function group() {
  const result = await create()
  expect(result.status).toBe('success')
  if (!result.conversationId) throw new Error('Expected an accepted synthetic group')
  return result.conversationId
}
function add(conversationId: string, handle: string) {
  return addGroupMembersAction({ status: 'idle' }, form({ conversationId, handles: handle }))
}
function send(conversationId: string, body: string, clientNonce = randomUUID()) {
  return sendMessageAction({ status: 'idle' }, form({ conversationId, body, clientNonce }))
}
function member(db: Tables, conversationId: string, name: Name) {
  return db.conversation_participants.find(row =>
    row.conversation_id === conversationId && row.profile_id === accounts[name].id)!
}

beforeEach(async () => {
  resetLocalCache()
  auth.tokens.clear()
  auth.cookieOverride = undefined
  auth.getUser.mockReset()
  auth.getUser.mockImplementation(async () => (await import('@/lib/local/session')).getLocalUser())
  if (process.platform === 'win32') {
    vi.stubEnv('BULLA_TEST_TMP_DIR', 'D:/All tasks + Automations/Bulla-Recovery/test-fixtures/message-groups')
  }
  workspace = await createTempWorkspace('message-groups')
  fixtureFile = path.join(workspace.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', fixtureFile)
  accounts = { alice: profile('alice'), bob: profile('bob'), carol: profile('carol') }
  for (const account of Object.values(accounts)) auth.tokens.set(account.user_id, randomBytes(32).toString('base64url'))
  await fs.writeFile(fixtureFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: Object.values(accounts).map(account => ({
      id: account.user_id, email: `${account.username}@example.test`, password_hash: '', created_at: CREATED,
    })),
    profiles: Object.values(accounts),
    sessions: [...auth.tokens].map(([userId, token]) => ({
      id: localId('ses'), user_id: userId, token_hash: createHash('sha256').update(token).digest('hex'),
      created_at: CREATED, expires_at: '2026-11-01T08:00:00.000Z',
    })),
    conversations: [], conversation_participants: [], messages: [], notifications: [],
    message_memberships: [], mutation_limit_windows: [],
  }), 'utf8')
  // Only Date is frozen; the existing filesystem lock still uses real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(JOIN)
  as('alice')
  await connect('alice', 'bob')
})
afterEach(async () => {
  auth.userId = null
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

describe('reachable creation and persisted roles', () => {
  it('dedupes normalized handles, persists the founder/admin and reports safe partial skips', async () => {
    const result = await create(`@${accounts.bob.username.toUpperCase()}, ${accounts.bob.username}, ${accounts.carol.username}`)
    expect(result).toMatchObject({ status: 'success' })
    expect(result.message).toContain('1 person added. 1 not added.')
    expect(result.message).not.toContain(accounts.carol.username)
    const db = await readStore()
    expect(db.conversation_participants.map(row => [row.profile_id, row.role]))
      .toEqual([[accounts.alice.id, 'admin'], [accounts.bob.id, 'member']])
    expect((db as Fixture).message_memberships?.map(row => [row.joined_at, row.left_at]))
      .toEqual([[JOIN, null], [JOIN, null]])
    as('bob')
    expect(await getConversationPane(result.conversationId!, accounts.bob.user_id))
      .toMatchObject({ reader_profile_id: accounts.bob.id, group: { role: 'member', active_count: 2, admin_count: 1 } })
    as('carol')
    expect(await getConversationPane(result.conversationId!, accounts.carol.user_id)).toBeNull()
  })

  it.each(['not-connected', 'pending', 'nobody', 'private', 'blocked', 'disabled', 'malformed-suspension'] as const)(
    'creates nothing when the sole candidate is %s',
    async refusal => {
      await seed(db => {
        if (refusal === 'not-connected') db.connections = []
        if (refusal === 'pending') db.connections[0].status = 'pending'
        if (refusal === 'nobody') db.profiles.find(row => row.id === accounts.bob.id)!.allow_messages_from = 'nobody'
        if (refusal === 'private') db.profiles.find(row => row.id === accounts.bob.id)!.visibility = 'private'
        if (refusal === 'blocked') db.blocks.push({
          id: localId('blk'), blocker_id: accounts.bob.id, blocked_id: accounts.alice.id, reason: null, created_at: JOIN,
        })
        if (refusal === 'disabled') db.users.find(row => row.id === accounts.bob.user_id)!.disabled_at = JOIN
        if (refusal === 'malformed-suspension') db.profile_account_states.push({
          id: localId('state'), profile_id: accounts.bob.id, status: 'suspended',
          suspended_until: '0000-invalid', warning_count: 0,
        })
      })
      expect(await create()).toMatchObject({ status: 'error', message: expect.stringContaining('no group was created') })
      const db = await readStore()
      expect(db.conversations).toEqual([])
      expect(db.conversation_participants).toEqual([])
      expect(db.mutation_limit_windows).toEqual([])
    },
  )

  it('refuses oversized forms before creation and retains the submitted values', async () => {
    const handles = Array.from({ length: 11 }, (_, i) => `synthetic_${i}`).join(',')
    expect(await create(handles)).toMatchObject({ status: 'error', values: { handles }, fieldErrors: { handles: expect.any(String) } })
    expect((await readStore()).conversations).toEqual([])
  })

  it('does not infer a legacy administrator from participant order, creation or a global staff role', async () => {
    const conversationId = await group()
    await seed(db => {
      for (const row of db.conversation_participants) delete row.role
      Object.assign(db.conversations[0], { created_by: accounts.alice.id })
      db.user_roles.push({ id: localId('rol'), user_id: accounts.carol.user_id, role: 'admin', created_at: JOIN })
    })
    const db = await readStore()
    expect(groupManagementPaneLocal(db, conversationId, accounts.alice)).toMatchObject({ role: 'member', admin_count: 0 })
    expect(await setGroupMemberRoleAction(conversationId, accounts.alice.id, 'admin')).toMatchObject({ ok: false })
    as('carol')
    expect(await add(conversationId, accounts.carol.username)).toMatchObject({ status: 'error' })
    expect(groupManagementPaneLocal(db, conversationId, accounts.carol)).toBeNull()
  })
})

describe('actual admin authority and final-admin protection', () => {
  it('denies member self-promotion, permits genuine promotion/handoff, and protects the last viable admin', async () => {
    const conversationId = await group()
    as('bob')
    expect(await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')).toMatchObject({ ok: false })
    as('alice')
    expect(await setGroupMemberRoleAction(conversationId, accounts.alice.id, 'member'))
      .toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    expect(await removeGroupMemberAction(conversationId, accounts.alice.id))
      .toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    expect(await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')).toMatchObject({ ok: true })
    expect(await setGroupMemberRoleAction(conversationId, accounts.alice.id, 'member')).toMatchObject({ ok: true })
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: true, left: true })
    as('bob')
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    expect(member(await readStore(), conversationId, 'bob').role).toBe('admin')
  })

  it.each([null, '0000-invalid', '2099-01-01T00:00:00.000Z'])(
    'does not count a suspended co-admin with deadline %s as a viable successor',
    async deadline => {
      const conversationId = await group()
      await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')
      await seed(db => { db.profile_account_states.push({
        id: localId('state'), profile_id: accounts.bob.id, status: 'suspended',
        suspended_until: deadline, warning_count: 0,
      }) })
      expect(groupManagementPaneLocal(await readStore(), conversationId, accounts.alice)?.admin_count).toBe(1)
      expect(await leaveConversationAction(conversationId)).toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    },
  )

  it('counts a genuinely expired temporary suspension, while preserving the independent ledger', async () => {
    const conversationId = await group()
    await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')
    await seed(db => { db.profile_account_states.push({
      id: localId('state'), profile_id: accounts.bob.id, status: 'suspended',
      suspended_until: CREATED, warning_count: 0,
    }) })
    expect(groupManagementPaneLocal(await readStore(), conversationId, accounts.alice)?.admin_count).toBe(2)
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: true, left: true })
    expect((await readStore()).mutation_limit_windows).toEqual([])
  })

  it('serializes simultaneous same-cookie final-admin departures into one accepted leave, never zero admins', async () => {
    const conversationId = await group()
    await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')
    const results = await Promise.all([leaveConversationAction(conversationId), leaveConversationAction(conversationId)])
    expect(results.filter(row => row.ok)).toHaveLength(1)
    const db = await readStore()
    expect(groupManagementPaneLocal(db, conversationId, accounts.bob)?.admin_count).toBe(1)
    as('bob')
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: false, message: FINAL_GROUP_ADMIN_COPY })
    // One in-process/filesystem fixture is not independent hosted transaction evidence.
  })
})

describe('bounded membership, re-add windows, activity and budgets', () => {
  it('preserves history/preview, excludes the gap/report target, and resets a departed admin to member', async () => {
    const conversationId = await group()
    await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')
    vi.setSystemTime(DURING)
    await send(conversationId, 'Synthetic retained group message')
    const retainedActivity = (await readStore()).notifications
    as('bob')
    vi.setSystemTime(LEAVE)
    expect(await leaveConversationAction(conversationId)).toEqual({ ok: true, left: true })
    as('alice')
    vi.setSystemTime(GAP)
    await send(conversationId, 'Synthetic inaccessible absence')
    const gapId = (await readStore()).messages.at(-1)!.id
    expect((await readStore()).notifications).toEqual(retainedActivity)
    as('bob')
    expect(await getConversationPane(conversationId, accounts.bob.user_id)).toMatchObject({ left: true, unread_count: 0, group: null })
    expect((await listThreadMessages({ conversationId })).messages?.map(row => row.body)).toEqual(['Synthetic retained group message'])
    as('alice')
    vi.setSystemTime(REJOIN)
    expect(await add(conversationId, accounts.bob.username)).toMatchObject({ status: 'success' })
    const rejoined = await readStore() as Fixture
    expect(member(rejoined, conversationId, 'bob').role).toBe('member')
    expect(rejoined.message_memberships?.filter(row => row.profile_id === accounts.bob.id)
      .map(row => [row.joined_at, row.left_at])).toEqual([[JOIN, LEAVE], [REJOIN, null]])
    expect(messageReportTargetLocal(rejoined, gapId, accounts.bob)).toBeNull()
    vi.setSystemTime('2026-10-31T11:01:00.000Z')
    await send(conversationId, 'Synthetic fresh interval message')
    as('bob')
    expect((await listThreadMessages({ conversationId })).messages?.map(row => row.body))
      .toEqual(['Synthetic retained group message', 'Synthetic fresh interval message'])
    expect(await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')).toMatchObject({ ok: false })
  })

  it('allows established group consent after Nobody, but refuses re-add until reachability is restored', async () => {
    const conversationId = await group()
    await seed(db => { db.profiles.find(row => row.id === accounts.bob.id)!.allow_messages_from = 'nobody' })
    vi.setSystemTime(DURING)
    expect((await send(conversationId, 'Synthetic existing consent')).status).toBe('success')
    as('bob')
    vi.setSystemTime(LEAVE)
    await leaveConversationAction(conversationId)
    as('alice')
    expect(await add(conversationId, accounts.bob.username)).toMatchObject({ status: 'error', message: expect.stringContaining('0 people added.') })
    expect((await readStore() as Fixture).message_memberships?.filter(row => row.profile_id === accounts.bob.id)).toHaveLength(1)
  })

  it('prevents new additions against a departed recorded member block, including the reverse direction', async () => {
    const conversationId = await group()
    await connect('alice', 'carol')
    as('bob')
    await leaveConversationAction(conversationId)
    as('alice')
    await seed(db => { db.blocks.push({
      id: localId('blk'), blocker_id: accounts.carol.id, blocked_id: accounts.bob.id, reason: null, created_at: JOIN,
    }) })
    expect(await add(conversationId, accounts.carol.username)).toMatchObject({ status: 'error' })
    expect((await readStore()).conversation_participants).toHaveLength(2)
  })

  it('refuses the twenty-first active member with truthful skip counts', async () => {
    const conversationId = await group()
    await connect('alice', 'carol')
    await seed(db => {
      for (let i = 0; i < 18; i++) {
        const profileId = localId('prf')
        db.conversation_participants.push({ id: localId('par'), conversation_id: conversationId, profile_id: profileId, role: 'member', last_read_at: null })
        db.message_memberships!.push({ conversation_id: conversationId, profile_id: profileId, joined_at: JOIN, left_at: null })
      }
    })
    expect(await add(conversationId, accounts.carol.username)).toMatchObject({ status: 'error', message: expect.stringContaining('1 not added.') })
    expect((await readStore()).conversation_participants).toHaveLength(20)
  })

  it('bounds recorded members at fifty but permits a reachable existing member to start a new interval', async () => {
    const conversationId = await group()
    await connect('alice', 'carol')
    as('bob')
    vi.setSystemTime(LEAVE)
    await leaveConversationAction(conversationId)
    as('alice')
    await seed(db => {
      for (let i = 0; i < 48; i++) {
        const profileId = localId('prf')
        db.conversation_participants.push({
          id: localId('par'), conversation_id: conversationId, profile_id: profileId,
          role: 'member', last_read_at: null,
        })
        db.message_memberships!.push({ conversation_id: conversationId, profile_id: profileId, joined_at: JOIN, left_at: LEAVE })
      }
    })
    vi.setSystemTime(REJOIN)
    expect(await add(conversationId, accounts.carol.username)).toMatchObject({ status: 'error' })
    expect(await add(conversationId, accounts.bob.username)).toMatchObject({ status: 'success' })
    const db = await readStore() as Fixture
    expect(db.conversation_participants).toHaveLength(50)
    expect(db.message_memberships?.filter(row => row.profile_id === accounts.bob.id)).toHaveLength(2)
    expect(groupManagementPaneLocal(db, conversationId, accounts.alice)?.members).toHaveLength(50)
  })

  it('keeps accepted nonce retries atomic and preserves the ledger through group role changes and budget refusal', async () => {
    const conversationId = await group()
    vi.setSystemTime(DURING)
    const nonce = randomUUID()
    await send(conversationId, 'Synthetic once-only group send', nonce)
    const before = await readStore()
    await send(conversationId, 'Synthetic once-only group send', nonce)
    await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')
    expect((await readStore()).messages).toEqual(before.messages)
    expect((await readStore()).notifications).toEqual(before.notifications)
    expect((await readStore()).mutation_limit_windows).toEqual(before.mutation_limit_windows)
    await seed(db => { db.mutation_limit_windows[0].hits = RATE_LIMITS['message:write'].limit })
    const full = await readStore()
    expect((await send(conversationId, 'Synthetic over-budget group message')).status).toBe('error')
    expect(await readStore()).toEqual(full)
  })
})

describe('locked group session authorization', () => {
  it.each(['missing', 'malformed', 'unknown', 'expired', 'revoked', 'invalid-date', 'future-session'] as const)(
    'denies creation/management with a %s bearer even if getUser preauthorization is stale',
    async state => {
      const conversationId = await group()
      if (state === 'missing') auth.cookieOverride = null
      if (state === 'malformed') auth.cookieOverride = 'invalid-session'
      if (state === 'unknown') auth.cookieOverride = randomBytes(32).toString('base64url')
      await seed(db => {
        const session = db.sessions.find(row => row.user_id === accounts.alice.user_id)!
        if (state === 'expired') session.expires_at = JOIN
        if (state === 'revoked') db.sessions = db.sessions.filter(row => row.id !== session.id)
        if (state === 'invalid-date') session.expires_at = 'not-an-instant'
        if (state === 'future-session') session.created_at = REJOIN
      })
      auth.getUser.mockResolvedValue({ id: accounts.alice.user_id })
      const before = await readStore()
      expect((await create()).status).toBe('error')
      expect((await add(conversationId, accounts.carol.username)).status).toBe('error')
      expect(await setGroupMemberRoleAction(conversationId, accounts.bob.id, 'admin')).toMatchObject({ ok: false })
      expect(await removeGroupMemberAction(conversationId, accounts.bob.id)).toMatchObject({ ok: false })
      expect(await leaveConversationAction(conversationId)).toMatchObject({ ok: false })
      expect(await readStore()).toEqual(before)
      expect(auth.getUser).not.toHaveBeenCalled()
    },
  )
})
