import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, expectRejection, type TestDb } from './harness'

let db: TestDb
let alice: string
let bob: string
let carol: string
let staff: string
let sequence = 0

beforeAll(async () => { db = await createTestDb() }, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  const suffix = `${++sequence}_${randomUUID().slice(0, 8)}`
  alice = await db.createUser({ username: `group_a_${suffix}` })
  bob = await db.createUser({ username: `group_b_${suffix}` })
  carol = await db.createUser({ username: `group_c_${suffix}` })
  staff = await db.createUser({ username: `group_s_${suffix}`, role: 'moderator' })
  await connect(alice, bob)
})

/** Explicit synthetic accepted-consent fixtures, not production signup defaults. */
async function connect(a: string, b: string) {
  await db.asService(
    `insert into public.connections(requester_id, addressee_id, status)
     values ($1, $2, 'accepted') on conflict do nothing`, [a, b],
  )
}

async function create(members = [bob], actor = alice) {
  const rows = await db.asUser<{ result: { conversation_id: string; added: number; skipped: number } }>(
    actor, 'select public.message_create_group($1, $2::uuid[]) as result',
    [`Synthetic group ${randomUUID()}`, members],
  )
  return rows[0].result
}

async function add(conversationId: string, members: string[], actor = alice) {
  const rows = await db.asUser<{ result: { added: number; skipped: number } }>(
    actor, 'select public.message_add_group_members($1, $2::uuid[]) as result', [conversationId, members],
  )
  return rows[0].result
}

function role(conversationId: string, target: string, value: string, actor = alice) {
  return db.asUser(actor, 'select public.message_set_group_role($1, $2, $3)', [conversationId, target, value])
}

async function send(conversationId: string, actor: string, body: string, nonce = randomUUID()) {
  return db.asUser<{ id: string }>(actor,
    'insert into public.messages(conversation_id, body, client_nonce) values ($1, $2, $3) returning id',
    [conversationId, body, nonce])
}

describe('bounded reachable group creation and direct-write guards', () => {
  it('persists a real founder role and reports partial skips without revealing a private reason', async () => {
    const result = await create([bob, carol, bob])
    expect(result).toMatchObject({ added: 1, skipped: 1 })
    const rows = await db.asUser(alice,
      'select profile_id, role from public.conversation_participants where conversation_id = $1 order by role',
      [result.conversation_id])
    expect(rows).toEqual([{ profile_id: alice, role: 'admin' }, { profile_id: bob, role: 'member' }])
    expect(await db.asUser(carol, 'select * from public.message_conversation_summaries where id = $1',
      [result.conversation_id])).toEqual([])
  })

  it('rejects all-unreachable and oversized creation atomically, including the legacy RPC', async () => {
    await expectRejection(() => create([carol]), /no reachable members/i)
    await expectRejection(() => create(Array.from({ length: 11 }, () => bob)), /one to ten/i)
    await expectRejection(() => db.asUser(alice,
      'select public.create_group_conversation($1, $2::uuid[])', ['Synthetic legacy skipped', [bob, carol]],
    ), /some people could not be added/i)
    await expectRejection(() => db.asUser(alice,
      'select public.create_group_conversation($1)', ['Synthetic legacy empty'],
    ), /one to ten/i)
    expect(await db.asUser(alice,
      `select id from public.message_conversation_summaries where type = 'group'`)).toEqual([])
  })

  it('keeps a legitimate old creation signature but gives it the same reachability rule', async () => {
    const rows = await db.asUser<{ id: string }>(alice,
      'select public.create_group_conversation($1, $2::uuid[]) as id', ['Synthetic legacy valid', [bob]])
    expect(rows[0].id).toBeTruthy()
    expect(await db.asUser(bob, 'select id from public.message_conversation_summaries where id = $1',
      [rows[0].id])).toEqual([{ id: rows[0].id }])
  })

  it('uses incoming preference and profile readability for new membership, not a staff override', async () => {
    await db.asService("update public.profiles set allow_messages_from = 'nobody' where id = $1", [bob])
    await expectRejection(() => create(), /no reachable members/i)
    await db.asService("update public.profiles set allow_messages_from = 'everyone', visibility = 'private' where id = $1", [bob])
    await connect(staff, bob)
    await expectRejection(() => create([bob], staff), /no reachable members/i)
    await db.asService("update public.profiles set visibility = 'connections' where id = $1", [bob])
    expect((await create()).added).toBe(1)
  })

  it('prevents raw participant INSERT from bypassing reachability or minting an administrator', async () => {
    const { conversation_id: conversationId } = await create()
    await expectRejection(() => db.asUser(alice,
      'insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2)',
      [conversationId, carol]), /reachability/i)
    await connect(alice, carol)
    await expectRejection(() => db.asUser(alice,
      "insert into public.conversation_participants(conversation_id, profile_id, role) values ($1, $2, 'admin')",
      [conversationId, carol]), /reachability/i)
    expect(await add(conversationId, [carol])).toEqual({ added: 1, skipped: 0 })
  })

  it('enforces active-member capacity for guarded and raw additions without rewriting a larger legacy group', async () => {
    const { conversation_id: conversationId } = await create()
    for (let i = 0; i < 18; i++) {
      const member = await db.createUser({ username: `group_cap_${sequence}_${i}` })
      await db.asService(
        'insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2)',
        [conversationId, member])
    }
    await connect(alice, carol)
    expect(await add(conversationId, [carol])).toEqual({ added: 0, skipped: 1 })
    await expectRejection(() => db.asUser(alice,
      'insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2)',
      [conversationId, carol]), /member limit/i)
    // Service-only legacy compatibility is not an authenticated bypass.
    await db.asService('insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2)',
      [conversationId, carol])
    expect(await db.asUser(carol, 'select id from public.message_conversation_summaries where id = $1',
      [conversationId])).toEqual([{ id: conversationId }])
  })
})

describe('real admin transitions, block-aware re-add and retained intervals', () => {
  it('denies self-promotion, outsider management and global-staff group authority', async () => {
    const { conversation_id: conversationId } = await create()
    await expectRejection(() => role(conversationId, bob, 'admin', bob), /active group admin/i)
    await expectRejection(() => db.asUser(bob,
      "update public.conversation_participants set role = 'admin' where conversation_id = $1 and profile_id = $2",
      [conversationId, bob]), /only a conversation admin/i)
    for (const actor of [carol, staff]) {
      await expectRejection(() => add(conversationId, [carol], actor), /active group admin/i)
      await expectRejection(() => db.asUser(actor, 'select public.message_group_members($1)', [conversationId]), /unavailable/i)
    }
  })

  it('protects the final available admin across RPC and direct demotion/removal/leave', async () => {
    const { conversation_id: conversationId } = await create()
    for (const statement of [
      "select public.message_set_group_role($1, $2, 'member')",
      'select public.message_remove_group_member($1, $2)',
      "update public.conversation_participants set role = 'member' where conversation_id = $1 and profile_id = $2",
      'update public.conversation_participants set left_at = clock_timestamp() where conversation_id = $1 and profile_id = $2',
    ]) await expectRejection(() => db.asUser(alice, statement, [conversationId, alice]), /final active group admin/i)
    await expectRejection(() => db.asUser(alice, 'select public.message_leave_conversation($1)', [conversationId]),
      /final active group admin/i)
    await role(conversationId, bob, 'admin')
    await role(conversationId, alice, 'member', bob)
    expect(await db.asUser(alice, 'select public.message_leave_conversation($1) as left', [conversationId]))
      .toEqual([{ left: true }])
  })

  it('does not count a suspended co-admin as a viable successor', async () => {
    const { conversation_id: conversationId } = await create()
    await role(conversationId, bob, 'admin')
    await db.asService("update public.profiles set status = 'suspended', suspended_until = '2099-01-01' where id = $1", [bob])
    await expectRejection(() => db.asUser(alice, 'select public.message_leave_conversation($1)', [conversationId]),
      /final active group admin/i)
  })

  it('preserves old history/preview and denies the absence after a real re-add, including report targets', async () => {
    const { conversation_id: conversationId } = await create()
    await db.asService("update public.conversation_participants set joined_at = '2026-10-01T10:00:00Z' where conversation_id = $1",
      [conversationId])
    async function fixture(body: string, at: string) {
      return (await db.asService<{ id: string }>(
        'insert into public.messages(conversation_id, sender_id, body, created_at) values ($1, $2, $3, $4) returning id',
        [conversationId, alice, body, at]))[0].id
    }
    await fixture('Synthetic before join', '2026-10-01T09:59:59Z')
    const retained = await fixture('Synthetic retained group history', '2026-10-01T11:00:00Z')
    await db.asService("update public.conversation_participants set left_at = '2026-10-01T12:00:00Z' where conversation_id = $1 and profile_id = $2",
      [conversationId, bob])
    const gap = await fixture('Synthetic inaccessible absence', '2026-10-01T13:00:00Z')
    expect(await db.asUser(bob, 'select id, body from public.messages where conversation_id = $1', [conversationId]))
      .toEqual([{ id: retained, body: 'Synthetic retained group history' }])
    await db.asService("update public.profiles set allow_messages_from = 'nobody' where id = $1", [bob])
    expect(await add(conversationId, [bob])).toEqual({ added: 0, skipped: 1 })
    await expectRejection(() => db.asUser(alice,
      'update public.conversation_participants set left_at = null where conversation_id = $1 and profile_id = $2',
      [conversationId, bob]), /reachability/i)
    await db.asService("update public.profiles set allow_messages_from = 'everyone' where id = $1", [bob])
    expect(await add(conversationId, [bob])).toEqual({ added: 1, skipped: 0 })
    const fresh = (await send(conversationId, alice, 'Synthetic new interval history'))[0].id
    expect(await db.asUser(bob, 'select id from public.messages where conversation_id = $1 order by created_at',
      [conversationId])).toEqual([{ id: retained }, { id: fresh }])
    await expectRejection(() => db.asUser(bob,
      "insert into public.reports(kind, reason, message_id) values ('message', 'Harassment', $1)", [gap]),
    /only report something you can see/i)
    const summary = await db.asUser<{ last_message_preview: string }>(bob,
      'select last_message_preview from public.message_conversation_summaries where id = $1', [conversationId])
    expect(summary[0].last_message_preview).toBe('Synthetic new interval history')
  })

  it('resets a departed admin to member rather than silently restoring old authority', async () => {
    const { conversation_id: conversationId } = await create()
    await role(conversationId, bob, 'admin')
    await db.asUser(bob, 'select public.message_leave_conversation($1)', [conversationId])
    expect(await add(conversationId, [bob])).toEqual({ added: 1, skipped: 0 })
    expect(await db.asUser(bob,
      'select role from public.conversation_participants where conversation_id = $1 and profile_id = $2',
      [conversationId, bob])).toEqual([{ role: 'member' }])
    await expectRejection(() => role(conversationId, alice, 'member', bob), /active group admin/i)
  })

  it('blocks an addition/re-add against any recorded member, including a departed member', async () => {
    const { conversation_id: conversationId } = await create()
    await connect(alice, carol)
    await db.asUser(bob, 'select public.message_leave_conversation($1)', [conversationId])
    await db.asUser(bob, 'insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [bob, carol])
    expect(await add(conversationId, [carol])).toEqual({ added: 0, skipped: 1 })
    await expectRejection(() => db.asUser(alice,
      'insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2)',
      [conversationId, carol]), /reachability/i)
  })

  it('keeps existing consented group sends independent from Nobody, but blocking suppresses history/sends', async () => {
    const { conversation_id: conversationId } = await create()
    await db.asService("update public.profiles set allow_messages_from = 'nobody' where id = $1", [bob])
    expect(await send(conversationId, alice, 'Synthetic existing group consent')).toHaveLength(1)
    await db.asUser(bob, 'select public.message_leave_conversation($1)', [conversationId])
    await db.asUser(bob, 'insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [bob, alice])
    expect(await db.asUser(alice, 'select body from public.messages where conversation_id = $1', [conversationId])).toEqual([])
    await expectRejection(() => send(conversationId, alice, 'Synthetic blocked group send'), /group messaging is blocked/i)
  })

  it('returns bounded bodyless current member controls, not controls to departed readers', async () => {
    const { conversation_id: conversationId } = await create()
    const rows = await db.asUser<{ result: { role: string; active_count: number; admin_count: number; members: unknown[] } }>(
      alice, 'select public.message_group_members($1) as result', [conversationId])
    expect(rows[0].result).toMatchObject({ role: 'admin', active_count: 2, admin_count: 1 })
    expect(rows[0].result.members).toHaveLength(2)
    expect(JSON.stringify(rows[0].result)).not.toMatch(/"body"|"unread_count"|"last_read_at"/)
    await db.asUser(bob, 'select public.message_leave_conversation($1)', [conversationId])
    await expectRejection(() => db.asUser(bob, 'select public.message_group_members($1)', [conversationId]), /unavailable/i)
  })

  it('keeps all new group helpers owner-only and RPCs authenticated-only without table grant expansion', async () => {
    for (const signature of [
      'public.message_create_group(text,uuid[])', 'public.message_add_group_members(uuid,uuid[])',
      'public.message_set_group_role(uuid,uuid,text)', 'public.message_remove_group_member(uuid,uuid)',
      'public.message_leave_conversation(uuid)', 'public.message_group_members(uuid)',
    ]) {
      const rows = await db.asService<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
          has_function_privilege('authenticated', $1, 'execute') as authenticated,
          has_function_privilege('service_role', $1, 'execute') as service`, [signature])
      expect(rows).toEqual([{ anon: false, authenticated: true, service: false }])
    }
    await expectRejection(() => db.asUser(alice, 'select app.message_group_account_available($1)', [bob]),
      /permission denied/i)
    expect(await db.asService("select has_table_privilege('authenticated', 'public.conversations', 'insert') as allowed"))
      .toEqual([{ allowed: false }])
  })
})
