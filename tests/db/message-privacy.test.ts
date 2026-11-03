import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let alice: string
let bob: string
let carol: string
let moderator: string
let sequence = 0
const JOIN = '2026-10-01T10:00:00.000Z'
const BEFORE = '2026-10-01T09:59:59.000Z'
const DURING = '2026-10-01T10:01:00.000Z'
const LEAVE = '2026-10-01T10:02:00.000Z'
const GAP = '2026-10-01T10:03:00.000Z'

beforeAll(async () => { db = await createTestDb() }, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  sequence += 1
  alice = await db.createUser({ username: `mp_alice_${sequence}` })
  bob = await db.createUser({ username: `mp_bob_${sequence}` })
  carol = await db.createUser({ username: `mp_carol_${sequence}` })
  moderator = await db.createUser({ username: `mp_staff_${sequence}`, role: 'moderator' })
})

async function direct() {
  const rows = await db.asUser<{ id: string }>(
    alice, 'select public.start_direct_conversation($1) as id', [bob],
  )
  return rows[0].id
}

async function group() {
  for (const candidate of [bob, carol]) {
    await db.asService(
      `insert into public.connections (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now()) on conflict do nothing`,
      [alice, candidate],
    )
  }
  const rows = await db.asUser<{ id: string }>(
    alice, 'select public.create_group_conversation($1, $2::uuid[]) as id',
    ['Synthetic privacy group', [bob, carol]],
  )
  const conversationId = rows[0].id
  await db.asService(
    'update public.conversation_participants set joined_at = $2 where conversation_id = $1',
    [conversationId, JOIN],
  )
  return conversationId
}

async function send(conversationId: string, sender: string, body: string, clientNonce?: string) {
  const rows = await db.asUser<{ id: string; created_at: string }>(
    sender,
    `insert into public.messages(conversation_id, body, client_nonce)
     values ($1, $2, $3) returning id, created_at`,
    [conversationId, body, clientNonce ?? null],
  )
  return rows[0]
}

async function fixtureMessage(conversationId: string, body: string, at: string) {
  const rows = await db.asService<{ id: string }>(
    `insert into public.messages(conversation_id, sender_id, body, created_at)
     values ($1, $2, $3, $4) returning id`,
    [conversationId, alice, body, at],
  )
  return rows[0].id
}

async function departedGroup() {
  const conversationId = await group()
  const before = await fixtureMessage(conversationId, 'synthetic before join', BEFORE)
  const during = await fixtureMessage(conversationId, 'synthetic retained history', DURING)
  await db.asService(
    'update public.conversation_participants set left_at = $3 where conversation_id = $1 and profile_id = $2',
    [conversationId, bob, LEAVE],
  )
  const gap = await fixtureMessage(conversationId, 'synthetic absence secret', GAP)
  return { conversationId, before, during, gap }
}

async function report(sender: string, messageId: string) {
  return db.asUser<{ id: string }>(
    sender,
    `insert into public.reports(kind, reason, message_id)
     values ('message', 'Harassment', $1) returning id`,
    [messageId],
  )
}

describe('retained message membership windows', () => {
  it('retains valid history but rejects pre-join and post-departure direct message SELECTs', async () => {
    const { conversationId, during, before, gap } = await departedGroup()
    expect(await db.asUser(bob,
      'select id, body from public.messages where conversation_id = $1 order by created_at',
      [conversationId],
    )).toEqual([{ id: during, body: 'synthetic retained history' }])
    for (const id of [before, gap]) {
      expect(await db.asUser(bob, 'select id, body from public.messages where id = $1', [id])).toEqual([])
    }
    expect(await db.asUser(carol,
      'select id from public.messages where id = $1', [gap],
    )).toEqual([{ id: gap }])
  })

  it('includes exact joined_at/left_at boundaries and excludes the next instant', async () => {
    const conversationId = await group()
    const first = await fixtureMessage(conversationId, 'exact join', JOIN)
    const last = await fixtureMessage(conversationId, 'exact departure', LEAVE)
    await db.asService(
      'update public.conversation_participants set left_at = $3 where conversation_id = $1 and profile_id = $2',
      [conversationId, bob, LEAVE],
    )
    await fixtureMessage(conversationId, 'one millisecond too late', '2026-10-01T10:02:00.001Z')
    expect(await db.asUser(bob,
      'select id from public.messages where conversation_id = $1 order by created_at', [conversationId],
    )).toEqual([{ id: first }, { id: last }])
  })

  it('hides unsafe raw previews and returns a truthful retained summary with zero unread', async () => {
    const { conversationId } = await departedGroup()
    expect(await db.asUser(bob,
      'select id, last_message_preview from public.conversations where id = $1', [conversationId],
    )).toEqual([])
    const rows = await db.asUser<{
      last_message_at: string
      last_message_preview: string
      participants: { profile_id: string; unread_count: number; left_at: string | null }[]
    }>(bob, 'select * from public.message_conversation_summaries where id = $1', [conversationId])
    expect(rows).toHaveLength(1)
    expect(rows[0].last_message_preview).toBe('synthetic retained history')
    expect(new Date(rows[0].last_message_at).toISOString()).toBe(DURING)
    expect(rows[0].participants.every(row => row.unread_count === 0)).toBe(true)
    expect(rows[0].participants.find(row => row.profile_id === bob)?.left_at).not.toBeNull()
    expect(await db.asUser(bob, 'select public.total_unread_messages() as unread')).toEqual([{ unread: 0 }])
    expect(await db.asUser(bob,
      'select profile_id, unread_count from public.conversation_participants where conversation_id = $1',
      [conversationId],
    )).toEqual([{ profile_id: bob, unread_count: 0 }])
  })

  it('refuses absence-message reports without unlocking staff content, and permits retained reports', async () => {
    const { conversationId, during, gap } = await departedGroup()
    await expectRejection(() => report(bob, gap), /only report something you can see/i)
    expect(await db.asUser(moderator,
      'select id, body from public.messages where conversation_id = $1', [conversationId],
    )).toEqual([])
    expect(await report(bob, during)).toHaveLength(1)
    expect(await db.asUser(moderator,
      'select id, body from public.messages where conversation_id = $1', [conversationId],
    )).toEqual([{ id: during, body: 'synthetic retained history' }])
    expect(await db.asUser(bob, 'select id, body from public.messages where id = $1', [gap])).toEqual([])
  })

  it('archives departure on re-invitation without granting the gap or pre-join messages', async () => {
    const { conversationId, during, gap, before } = await departedGroup()
    await db.asUser(alice,
      'update public.conversation_participants set left_at = null where conversation_id = $1 and profile_id = $2',
      [conversationId, bob],
    )
    const fresh = await send(conversationId, alice, 'synthetic after reinvitation')
    expect(await db.asUser(bob,
      'select id from public.messages where conversation_id = $1 order by created_at', [conversationId],
    )).toEqual([{ id: during }, { id: fresh.id }])
    for (const messageId of [before, gap]) {
      expect(await db.asUser(bob, 'select id from public.messages where id = $1', [messageId])).toEqual([])
      await expectRejection(() => report(bob, messageId), /only report something you can see/i)
    }
    expect(await db.asUser(bob, 'select public.total_unread_messages() as unread')).toEqual([{ unread: 1 }])
    await expectRejection(() => db.asUser(bob,
      `insert into public.messages(conversation_id, body, reply_to_id)
       values ($1, 'cannot quote the gap', $2)`,
      [conversationId, gap],
    ), /cannot reply to a message you cannot read/i)
  })

  it('normalizes forged departure times and forbids extending an already closed interval', async () => {
    const conversationId = await group()
    const rows = await db.asUser<{ left_at: string }>(bob,
      `update public.conversation_participants set left_at = '2099-01-01'
       where conversation_id = $1 and profile_id = $2 returning left_at`,
      [conversationId, bob],
    )
    expect(new Date(rows[0].left_at).getUTCFullYear()).not.toBe(2099)
    await expectRejection(() => db.asUser(bob,
      `update public.conversation_participants set left_at = '2099-01-01'
       where conversation_id = $1 and profile_id = $2`,
      [conversationId, bob],
    ), /recorded departure cannot be changed/i)
    await expectRejection(() => db.asUser(bob,
      `update public.conversation_participants set left_at = null
       where conversation_id = $1 and profile_id = $2`,
      [conversationId, bob],
    ), /cannot rejoin/i)
  })

  it('retains separate windows through a second leave/rejoin rather than merging either absence', async () => {
    const { conversationId, during } = await departedGroup()
    const invite = () => db.asUser(alice,
      'update public.conversation_participants set left_at = null where conversation_id = $1 and profile_id = $2',
      [conversationId, bob],
    )
    await invite()
    const firstRejoin = await send(conversationId, alice, 'synthetic first rejoin message')
    await db.asUser(bob,
      'update public.conversation_participants set left_at = now() where conversation_id = $1 and profile_id = $2',
      [conversationId, bob],
    )
    const secondGap = await send(conversationId, alice, 'synthetic second absence secret')
    await invite()
    const secondRejoin = await send(conversationId, alice, 'synthetic second rejoin message')
    expect(await db.asUser(bob,
      'select id from public.messages where conversation_id = $1 order by created_at', [conversationId],
    )).toEqual([{ id: during }, { id: firstRejoin.id }, { id: secondRejoin.id }])
    await expectRejection(() => report(bob, secondGap.id), /only report something you can see/i)
    expect(await db.asUser(bob, 'select public.total_unread_messages() as unread')).toEqual([{ unread: 1 }])
  })

  it('does not let senders backdate a post-departure message into retained history', async () => {
    const { conversationId } = await departedGroup()
    const rows = await db.asUser<{ id: string; created_at: string }>(alice,
      `insert into public.messages(conversation_id, body, created_at)
       values ($1, 'synthetic backdated secret', $2) returning id, created_at`,
      [conversationId, DURING],
    )
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(Date.parse(LEAVE))
    expect(await db.asUser(bob, 'select id, body from public.messages where id = $1', [rows[0].id])).toEqual([])
  })

  it('does not expose a newly edited body through an old retained message or preview', async () => {
    const { conversationId, during } = await departedGroup()
    await db.asUser(alice, 'update public.messages set body = $2 where id = $1',
      [during, 'synthetic post-departure edit secret'],
    )
    expect(await db.asUser(bob, 'select id, body from public.messages where id = $1', [during])).toEqual([])
    const rows = await db.asUser(bob,
      'select last_message_preview from public.message_conversation_summaries where id = $1',
      [conversationId],
    )
    expect(rows).toEqual([{ last_message_preview: null }])
    await expectRejection(() => report(bob, during), /only report something you can see/i)
  })

  it('does not let an invitation backdate a new participant into existing content', async () => {
    const conversationId = await group()
    const old = await fixtureMessage(conversationId, 'synthetic before invitation', DURING)
    // The invitation must be legitimate under the current reachability rule;
    // accepted consent cannot grant access to content from before the join.
    await db.asService(
      `insert into public.connections(requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now())`,
      [alice, moderator],
    )
    await db.asUser(alice,
      `insert into public.conversation_participants(conversation_id, profile_id, joined_at)
       values ($1, $2, '2000-01-01')`,
      [conversationId, moderator],
    )
    expect(await db.asUser(moderator, 'select id from public.messages where id = $1', [old])).toEqual([])
    expect(await db.asUser(moderator,
      'select last_message_preview from public.message_conversation_summaries where id = $1',
      [conversationId],
    )).toEqual([{ last_message_preview: null }])
  })

  it('keeps the safe summary and private archive inaccessible to unrelated/anonymous callers', async () => {
    const { conversationId } = await departedGroup()
    expect(await db.asUser(moderator,
      'select * from public.message_conversation_summaries where id = $1', [conversationId],
    )).toEqual([])
    await expectRejection(() => db.asAnon('select * from public.message_conversation_summaries'), REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(bob,
      'select * from app.message_membership_history',
    ), REJECTS.permissionDenied)
    expect(await db.asUser(moderator,
      'select * from app.message_conversation_summary($1)', [conversationId],
    )).toEqual([])
    expect(await db.asUser(bob,
      'select last_message_preview from app.message_conversation_summary($1)', [conversationId],
    )).toEqual([{ last_message_preview: 'synthetic retained history' }])
  })
})

describe('direct-message preference contract and replay', () => {
  it('stops new and existing incoming DMs after Nobody while retaining history and outbound consent', async () => {
    const conversationId = await direct()
    const old = await send(conversationId, alice, 'synthetic earlier accepted DM')
    await db.asUser(bob, "update public.profiles set allow_messages_from = 'nobody' where id = $1", [bob])
    await expectRejection(() => send(conversationId, alice, 'must not arrive'), /cannot message this person/i)
    await expectRejection(() => db.asUser(carol,
      'select public.start_direct_conversation($1)', [bob],
    ), /cannot message this person/i)
    expect(await db.asUser(bob, 'select id from public.messages where id = $1', [old.id])).toEqual([{ id: old.id }])
    expect(await send(conversationId, bob, 'outbound follows Alice preference')).toHaveProperty('id')
    await db.asUser(bob, "update public.profiles set allow_messages_from = 'everyone' where id = $1", [bob])
    expect(await send(conversationId, alice, 'incoming after explicit enable')).toHaveProperty('id')
  })

  it.each(['university', 'connections'] as const)(
    'rechecks %s on an existing DM and permits it only after the relationship becomes valid',
    async (preference) => {
      const conversationId = await direct()
      await db.asUser(bob, 'update public.profiles set allow_messages_from = $2 where id = $1', [bob, preference])
      await expectRejection(() => send(conversationId, alice, 'relationship absent'), /cannot message this person/i)
      if (preference === 'connections') {
        await db.asService(
          "insert into public.connections(requester_id, addressee_id, status) values ($1, $2, 'accepted')",
          [alice, bob],
        )
      } else {
        const universities = await db.asService<{ id: string }>('select id from public.universities limit 1')
        expect(universities).toHaveLength(1)
        await db.asService('update public.profiles set university_id = $2 where id in ($1, $3)',
          [alice, universities[0].id, bob],
        )
      }
      expect(await send(conversationId, alice, 'relationship now accepted')).toHaveProperty('id')
    },
  )

  it.each(['alice', 'bob'] as const)('enforces either-way blocking when %s blocks', async (blocker) => {
    const conversationId = await direct()
    const from = blocker === 'alice' ? alice : bob
    const to = blocker === 'alice' ? bob : alice
    await db.asUser(from, 'insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [from, to])
    for (const sender of [alice, bob]) {
      await expectRejection(() => send(conversationId, sender, 'blocked message'), /cannot message this person/i)
    }
  })

  it('uses derived suspension expiry for recipient consent instead of permanently rejecting a stale status', async () => {
    const conversationId = await direct()
    await db.asService(
      `update public.profiles set status = 'suspended', suspended_until = now() - interval '1 second'
       where id = $1`, [bob],
    )
    const incoming = await send(conversationId, alice, 'synthetic after suspension expiry')
    expect(await db.asUser(bob, 'select id from public.messages where id = $1', [incoming.id])).toEqual([{ id: incoming.id }])
  })

  it.each(['banned', 'deactivated', 'suspended'])('refuses a still-%s recipient without deleting existing history', async (status) => {
    const conversationId = await direct()
    const old = await send(conversationId, alice, 'synthetic history before restriction')
    await db.asService(
      `update public.profiles set status = $2, suspended_until = now() + interval '1 day'
       where id = $1`, [bob, status],
    )
    await expectRejection(() => send(conversationId, alice, 'restricted recipient'), /cannot message this person/i)
    expect(await db.asUser(alice, 'select id from public.messages where id = $1', [old.id])).toEqual([{ id: old.id }])
  })

  it('does not silently re-add a departed recipient; explicit caller rejoin preserves the original interval', async () => {
    const conversationId = await direct()
    const old = await send(conversationId, alice, 'synthetic before direct leave')
    await db.asUser(bob,
      'update public.conversation_participants set left_at = now() where conversation_id = $1 and profile_id = $2',
      [conversationId, bob],
    )
    expect(await db.asUser(alice, 'select public.start_direct_conversation($1) as id', [bob])).toEqual([{ id: conversationId }])
    await expectRejection(() => send(conversationId, alice, 'recipient left'), /cannot message this person/i)
    await expectRejection(() => send(conversationId, bob, 'sender left'), /not a participant/i)
    expect(await db.asUser(bob, 'select public.start_direct_conversation($1) as id', [alice])).toEqual([{ id: conversationId }])
    expect(await db.asUser(bob, 'select id from public.messages where id = $1', [old.id])).toEqual([{ id: old.id }])
    expect(await send(conversationId, alice, 'synthetic after direct rejoin')).toHaveProperty('id')
  })

  it('leaves group preferences separate without bypassing either-way blocks', async () => {
    const conversationId = await group()
    await db.asUser(bob, "update public.profiles set allow_messages_from = 'nobody' where id = $1", [bob])
    expect(await send(conversationId, alice, 'consented group message')).toHaveProperty('id')
    await db.asUser(bob, 'insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [bob, alice])
    await expectRejection(() => send(conversationId, alice, 'blocked group message'), /cannot message this person/i)
  })

  it('retains one durable send/unread for the same sender nonce and rejects changing its body', async () => {
    const conversationId = await direct()
    const nonce = '11111111-1111-4111-8111-111111111111'
    const original = await send(conversationId, alice, 'synthetic idempotent send', nonce)
    await expectRejection(() => send(conversationId, alice, 'synthetic idempotent send', nonce), REJECTS.uniqueViolation)
    await expectRejection(() => send(conversationId, alice, 'nonce cannot mean another body', nonce), REJECTS.uniqueViolation)
    expect(await db.asUser(alice, 'select id from public.messages where client_nonce = $1', [nonce])).toEqual([{ id: original.id }])
    expect(await db.asUser(bob, 'select public.total_unread_messages() as unread')).toEqual([{ unread: 1 }])
    expect(await send(conversationId, bob, 'other sender may use its own nonce', nonce)).toHaveProperty('id')
    await expectRejection(() => db.asUser(alice,
      'update public.messages set client_nonce = $2 where id = $1',
      [original.id, '22222222-2222-4222-8222-222222222222'],
    ), REJECTS.permissionDenied)
  })
})
