/**
 * Messaging permission tests.
 *
 * These exist to prove one specific requirement, which is stated in the product
 * specification as a hard rule:
 *
 *   "Users must NOT be able to read another user's private conversation by
 *    manipulating IDs."
 *
 * Every test below therefore hands the attacker the real conversation id, the
 * real message id, and a valid session, and then checks that none of it helps.
 * A test that withheld the id would prove nothing -- ids leak through URLs,
 * logs, screenshots and API responses, so the schema has to assume the attacker
 * already has them.
 *
 * Assertions run through `asUser`, which sets the `authenticated` Postgres role
 * and the JWT `sub` claim. That is the same context PostgREST gives a browser
 * request, so a policy that passes here is the policy that ships. `asService` is
 * used only to build fixtures.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb

/** Alice and Bob talk to each other. Eve is the attacker; she is nobody's friend. */
let alice: string
let bob: string
let eve: string

beforeAll(async () => {
  db = await createTestDb()
  alice = await db.createUser({ username: 'alice', fullName: 'Alice' })
  bob = await db.createUser({ username: 'bob', fullName: 'Bob' })
  eve = await db.createUser({ username: 'eve', fullName: 'Eve' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** Open a real conversation between two users and send one message. */
async function seedThread(from: string, to: string, body: string) {
  const rows = await db.asUser<{ start_direct_conversation: string }>(
    from,
    `select public.start_direct_conversation($1)`,
    [to],
  )
  const conversationId = rows[0]!.start_direct_conversation

  const msg = await db.asUser<{ id: string }>(
    from,
    `insert into public.messages (conversation_id, body) values ($1, $2) returning id`,
    [conversationId, body],
  )

  return { conversationId, messageId: msg[0]!.id }
}

describe('starting a conversation', () => {
  it('creates one conversation with both participants', async () => {
    const { conversationId } = await seedThread(alice, bob, 'hello bob')

    const participants = await db.asService<{ profile_id: string }>(
      `select profile_id from public.conversation_participants
        where conversation_id = $1 order by profile_id`,
      [conversationId],
    )
    expect(participants).toHaveLength(2)
    expect(participants.map((p) => p.profile_id).sort()).toEqual([alice, bob].sort())
  })

  it('is idempotent regardless of who opens it', async () => {
    // The pair_low/pair_high unique index is what makes this true. Without it,
    // Alice messaging Bob and Bob messaging Alice would produce two threads and
    // each would see half the history.
    const first = await db.asUser<{ start_direct_conversation: string }>(
      alice,
      `select public.start_direct_conversation($1)`,
      [bob],
    )
    const second = await db.asUser<{ start_direct_conversation: string }>(
      bob,
      `select public.start_direct_conversation($1)`,
      [alice],
    )
    expect(second[0]!.start_direct_conversation).toBe(
      first[0]!.start_direct_conversation,
    )
  })

  it('refuses a conversation with yourself', async () => {
    await expectRejection(
      () =>
        db.asUser(alice, `select public.start_direct_conversation($1)`, [alice]),
      /yourself|self_conversation/i,
    )
  })
})

describe('reading a conversation you are not part of', () => {
  it('returns no messages even when the attacker has the conversation id', async () => {
    const { conversationId } = await seedThread(alice, bob, 'private matter')

    // Eve has the id. This is the whole attack.
    const rows = await db.asUser(
      eve,
      `select id, body from public.messages where conversation_id = $1`,
      [conversationId],
    )
    expect(rows).toEqual([])
  })

  it('returns no messages even when the attacker has the message id', async () => {
    const { messageId } = await seedThread(alice, bob, 'secret')

    const rows = await db.asUser(
      eve,
      `select id, body from public.messages where id = $1`,
      [messageId],
    )
    expect(rows).toEqual([])
  })

  it('hides the conversation row itself, including its preview', async () => {
    // The denormalised last_message_preview is a copy of message text. If the
    // conversation row leaked, the message body would leak with it.
    const { conversationId } = await seedThread(alice, bob, 'leak me')

    const rows = await db.asUser(
      eve,
      `select id, last_message_preview from public.conversations where id = $1`,
      [conversationId],
    )
    expect(rows).toEqual([])
  })

  it('hides the participant list, so membership is not enumerable', async () => {
    const { conversationId } = await seedThread(alice, bob, 'who is here')

    const rows = await db.asUser(
      eve,
      `select profile_id from public.conversation_participants
        where conversation_id = $1`,
      [conversationId],
    )
    expect(rows).toEqual([])
  })

  it('rejects an unauthenticated reader outright', async () => {
    const { conversationId } = await seedThread(alice, bob, 'not for the public')

    // Stronger than an empty result: `anon` holds no SELECT grant on messages at
    // all, so the statement is refused before RLS is even consulted.
    await expectRejection(
      () =>
        db.asAnon(`select id from public.messages where conversation_id = $1`, [
          conversationId,
        ]),
      REJECTS.permissionDenied,
    )
  })
})

describe('writing into a conversation you are not part of', () => {
  it('refuses to insert a message', async () => {
    const { conversationId } = await seedThread(alice, bob, 'ours')

    await expectRejection(
      () =>
        db.asUser(
          eve,
          `insert into public.messages (conversation_id, body) values ($1, $2)`,
          [conversationId, 'I am in your chat'],
        ),
      /not_participant|not a participant|row-level security/i,
    )
  })

  it('refuses to add itself as a participant of a direct conversation', async () => {
    // The obvious escalation: if you cannot read the thread, join it.
    //
    // Two independent defences refuse this, and the BEFORE trigger happens to
    // run before the RLS WITH CHECK, so its message is the one that surfaces.
    // The group-conversation test below isolates the RLS policy on its own.
    const { conversationId } = await seedThread(alice, bob, 'ours again')

    await expectRejection(
      () =>
        db.asUser(
          eve,
          `insert into public.conversation_participants (conversation_id, profile_id)
           values ($1, $2)`,
          [conversationId, eve],
        ),
      /exactly two participants|row-level security/i,
    )
  })

  it('refuses to add itself as a participant of a group conversation', async () => {
    // No participant-count trigger applies here, so the RLS insert policy is the
    // only thing standing between Eve and someone else's group chat.
    const groupRows = await db.asUser<{ create_group_conversation: string }>(
      alice,
      `select public.create_group_conversation($1, $2)`,
      ['Study group', [bob]],
    )
    const conversationId = groupRows[0]!.create_group_conversation

    await expectRejection(
      () =>
        db.asUser(
          eve,
          `insert into public.conversation_participants (conversation_id, profile_id)
           values ($1, $2)`,
          [conversationId, eve],
        ),
      REJECTS.rlsViolation,
    )

    // And she still cannot read it.
    const rows = await db.asUser(
      eve,
      `select id from public.conversations where id = $1`,
      [conversationId],
    )
    expect(rows).toEqual([])
  })

  it('refuses a third participant in a direct conversation even for a member', async () => {
    // Alice is a legitimate participant, so RLS is not the obstacle here -- the
    // trigger is. Turning a 1:1 into a group would expose history Eve was never
    // party to.
    const { conversationId } = await seedThread(alice, bob, 'strictly two')

    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.conversation_participants (conversation_id, profile_id)
           values ($1, $2)`,
          [conversationId, eve],
        ),
      /direct_conversation_full|exactly two|row-level security/i,
    )
  })
})

describe('message authorship', () => {
  it('forces sender_id to the caller, ignoring a forged value', async () => {
    const { conversationId } = await seedThread(alice, bob, 'genuine')

    // Bob is a real participant, so he is allowed to write here. He tries to
    // write *as Alice*.
    await db.asUser(
      bob,
      `insert into public.messages (conversation_id, sender_id, body)
       values ($1, $2, $3)`,
      [conversationId, alice, 'Alice said this'],
    )

    const rows = await db.asService<{ sender_id: string }>(
      `select sender_id from public.messages
        where conversation_id = $1 and body = 'Alice said this'`,
      [conversationId],
    )
    expect(rows).toHaveLength(1)
    // Overwritten by the trigger rather than rejected, so a forged id is simply
    // inert.
    expect(rows[0]!.sender_id).toBe(bob)
  })

  it('does not let a participant edit another participant\'s message', async () => {
    const { conversationId, messageId } = await seedThread(alice, bob, 'original text')

    // No error: the UPDATE policy filters the row out, so zero rows match.
    await db.asUser(bob, `update public.messages set body = 'tampered' where id = $1`, [
      messageId,
    ])

    const rows = await db.asService<{ body: string; is_edited: boolean }>(
      `select body, is_edited from public.messages where id = $1`,
      [messageId],
    )
    expect(rows[0]!.body).toBe('original text')
    expect(rows[0]!.is_edited).toBe(false)
    expect(conversationId).toBeTruthy()
  })

  it('marks a genuine edit as edited', async () => {
    const { messageId } = await seedThread(alice, bob, 'first draft')

    await db.asUser(alice, `update public.messages set body = 'second draft' where id = $1`, [
      messageId,
    ])

    const rows = await db.asService<{ body: string; is_edited: boolean; edited_at: string | null }>(
      `select body, is_edited, edited_at from public.messages where id = $1`,
      [messageId],
    )
    expect(rows[0]!.body).toBe('second draft')
    // Set by the trigger, so the client cannot silently rewrite history.
    expect(rows[0]!.is_edited).toBe(true)
    expect(rows[0]!.edited_at).not.toBeNull()
  })

  it('refuses to move a message into another conversation', async () => {
    const aliceBob = await seedThread(alice, bob, 'thread one')
    const aliceEve = await seedThread(alice, eve, 'thread two')

    // conversation_id is in the protected-column list: re-anchoring a message
    // would drag its text into a thread whose participants never received it.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.messages set conversation_id = $1 where id = $2`,
          [aliceEve.conversationId, aliceBob.messageId],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a reply that points at another conversation', async () => {
    const aliceBob = await seedThread(alice, bob, 'thread A')
    const aliceEve = await seedThread(alice, eve, 'thread B')

    // Otherwise the quoted preview would render text from a thread the reader
    // cannot see.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.messages (conversation_id, body, reply_to_id)
           values ($1, $2, $3)`,
          [aliceBob.conversationId, 'quoting across threads', aliceEve.messageId],
        ),
      /reply_cross_conversation|another conversation/i,
    )
  })
})

describe('messaging preferences', () => {
  it('blocks a new conversation when the recipient allows nobody', async () => {
    const hermit = await db.createUser({ username: 'hermit' })
    await db.asService(
      `update public.profiles set allow_messages_from = 'nobody' where id = $1`,
      [hermit],
    )

    await expectRejection(
      () => db.asUser(eve, `select public.start_direct_conversation($1)`, [hermit]),
      /messaging_not_permitted|cannot message/i,
    )
  })

  it('blocks a stranger when the recipient allows connections only', async () => {
    const picky = await db.createUser({ username: 'picky' })
    await db.asService(
      `update public.profiles set allow_messages_from = 'connections' where id = $1`,
      [picky],
    )

    await expectRejection(
      () => db.asUser(eve, `select public.start_direct_conversation($1)`, [picky]),
      /messaging_not_permitted|cannot message/i,
    )
  })

  it('allows a connection when the recipient allows connections only', async () => {
    const picky2 = await db.createUser({ username: 'picky2' })
    const friend = await db.createUser({ username: 'friend' })
    await db.asService(
      `update public.profiles set allow_messages_from = 'connections' where id = $1`,
      [picky2],
    )
    await db.asService(
      `insert into public.connections (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now())`,
      [friend, picky2],
    )

    const rows = await db.asUser<{ start_direct_conversation: string }>(
      friend,
      `select public.start_direct_conversation($1)`,
      [picky2],
    )
    expect(rows[0]!.start_direct_conversation).toBeTruthy()
  })

  it('gives the same error whichever preference caused the refusal', async () => {
    // The refusal must not be usable to probe someone's privacy settings: a
    // distinct message for "blocked you" versus "connections only" would leak
    // exactly what the setting is for.
    const hermit = await db.createUser({ username: 'hermit2' })
    const picky = await db.createUser({ username: 'picky3' })
    await db.asService(
      `update public.profiles set allow_messages_from = 'nobody' where id = $1`,
      [hermit],
    )
    await db.asService(
      `update public.profiles set allow_messages_from = 'connections' where id = $1`,
      [picky],
    )

    const a = await expectRejection(
      () => db.asUser(eve, `select public.start_direct_conversation($1)`, [hermit]),
      /cannot message/i,
    )
    const b = await expectRejection(
      () => db.asUser(eve, `select public.start_direct_conversation($1)`, [picky]),
      /cannot message/i,
    )
    expect(a.message).toBe(b.message)
  })
})

describe('blocking', () => {
  it('prevents opening a conversation in either direction', async () => {
    const blocker = await db.createUser({ username: 'blocker' })
    const blocked = await db.createUser({ username: 'blocked' })

    await db.asUser(
      blocker,
      `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`,
      [blocker, blocked],
    )

    // The blocked user obviously cannot reach the blocker...
    await expectRejection(
      () => db.asUser(blocked, `select public.start_direct_conversation($1)`, [blocker]),
      /cannot message/i,
    )
    // ...and the blocker cannot reach them either. A block that only worked one
    // way would let the blocker keep talking at someone who cannot reply.
    await expectRejection(
      () => db.asUser(blocker, `select public.start_direct_conversation($1)`, [blocked]),
      /cannot message/i,
    )
  })

  it('stops further messages in a thread that already existed', async () => {
    const p = await db.createUser({ username: 'chatty' })
    const q = await db.createUser({ username: 'regretful' })
    const { conversationId } = await seedThread(p, q, 'before the block')

    await db.asUser(q, `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [
      q,
      p,
    ])

    // Checked on every insert, not only when the conversation was opened.
    // Otherwise blocking someone would not stop an existing thread.
    await expectRejection(
      () =>
        db.asUser(
          p,
          `insert into public.messages (conversation_id, body) values ($1, $2)`,
          [conversationId, 'after the block'],
        ),
      /cannot message this person/i,
    )
  })
})

describe('unread state', () => {
  it('counts for the recipient only', async () => {
    const x = await db.createUser({ username: 'sender1' })
    const y = await db.createUser({ username: 'reader1' })
    const { conversationId } = await seedThread(x, y, 'ping')

    const rows = await db.asService<{ profile_id: string; unread_count: number }>(
      `select profile_id, unread_count from public.conversation_participants
        where conversation_id = $1`,
      [conversationId],
    )
    const counts = Object.fromEntries(rows.map((r) => [r.profile_id, r.unread_count]))
    expect(counts[y]).toBe(1)
    // Your own message is read by definition.
    expect(counts[x]).toBe(0)
  })

  it('resets only for the caller when marked read', async () => {
    const x = await db.createUser({ username: 'sender2' })
    const y = await db.createUser({ username: 'reader2' })
    const { conversationId } = await seedThread(x, y, 'ping')
    await db.asUser(
      x,
      `insert into public.messages (conversation_id, body) values ($1, 'ping again')`,
      [conversationId],
    )

    await db.asUser(y, `select public.mark_conversation_read($1)`, [conversationId])

    const rows = await db.asService<{ profile_id: string; unread_count: number }>(
      `select profile_id, unread_count from public.conversation_participants
        where conversation_id = $1`,
      [conversationId],
    )
    const counts = Object.fromEntries(rows.map((r) => [r.profile_id, r.unread_count]))
    expect(counts[y]).toBe(0)
  })

  it('refuses to mark a conversation read for a non-participant', async () => {
    const { conversationId } = await seedThread(alice, bob, 'not yours')

    await expectRejection(
      () => db.asUser(eve, `select public.mark_conversation_read($1)`, [conversationId]),
      /not_participant|not a participant/i,
    )
  })

  it('does not let a client write unread_count directly', async () => {
    const { conversationId } = await seedThread(alice, bob, 'ping')

    // unread_count is excluded from the column-level UPDATE grant, so "mark as
    // read" cannot be forged into "mark unread for everyone else".
    await expectRejection(
      () =>
        db.asUser(
          bob,
          `update public.conversation_participants set unread_count = 99
            where conversation_id = $1 and profile_id = $2`,
          [conversationId, bob],
        ),
      REJECTS.permissionDenied,
    )
  })
})

describe('denormalised conversation summary', () => {
  it('is maintained by trigger and not writable by the client', async () => {
    const { conversationId } = await seedThread(alice, bob, 'the latest thing')

    const rows = await db.asUser<{ last_message_preview: string }>(
      alice,
      `select last_message_preview from public.conversations where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.last_message_preview).toBe('the latest thing')

    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.conversations set last_message_preview = 'fake' where id = $1`,
          [conversationId],
        ),
      REJECTS.permissionDenied,
    )
  })
})

describe('message content rules', () => {
  it('rejects a message with neither body nor attachment', async () => {
    const { conversationId } = await seedThread(alice, bob, 'real message')

    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.messages (conversation_id, body) values ($1, '   ')`,
          [conversationId],
        ),
      REJECTS.checkViolation,
    )
  })

  it('rejects an attachment that is missing its metadata', async () => {
    const { conversationId } = await seedThread(alice, bob, 'real message')

    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.messages (conversation_id, attachment_path)
           values ($1, 'chat/x.png')`,
          [conversationId],
        ),
      REJECTS.checkViolation,
    )
  })

  it('rejects a disallowed attachment type', async () => {
    const { conversationId } = await seedThread(alice, bob, 'real message')

    // The upload surface is where arbitrary executables would arrive. The MIME
    // whitelist is enforced here and again in the storage policy.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.messages
             (conversation_id, attachment_path, attachment_mime, attachment_size)
           values ($1, 'chat/x.exe', 'application/x-msdownload', 1024)`,
          [conversationId],
        ),
      REJECTS.checkViolation,
    )
  })

  it('rejects an oversized attachment', async () => {
    const { conversationId } = await seedThread(alice, bob, 'real message')

    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.messages
             (conversation_id, attachment_path, attachment_mime, attachment_size)
           values ($1, 'chat/big.png', 'image/png', 20971520)`,
          [conversationId],
        ),
      REJECTS.checkViolation,
    )
  })
})

describe('leaving a conversation', () => {
  it('stops new messages reaching the leaver but keeps their history readable', async () => {
    const x = await db.createUser({ username: 'stayer' })
    const y = await db.createUser({ username: 'leaver' })
    const { conversationId, messageId } = await seedThread(x, y, 'before leaving')

    await db.asUser(
      y,
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, y],
    )

    // History stays visible: the thread should not blank out retroactively.
    const history = await db.asUser(
      y,
      `select id from public.messages where id = $1`,
      [messageId],
    )
    expect(history).toHaveLength(1)

    // But they can no longer post.
    await expectRejection(
      () =>
        db.asUser(
          y,
          `insert into public.messages (conversation_id, body) values ($1, 'still here')`,
          [conversationId],
        ),
      /not_participant|not a participant|row-level security/i,
    )
  })

  it('does not let someone rejoin a conversation they left', async () => {
    const x = await db.createUser({ username: 'stayer2' })
    const y = await db.createUser({ username: 'leaver2' })
    const { conversationId } = await seedThread(x, y, 'before leaving')

    await db.asUser(
      y,
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, y],
    )

    await expectRejection(
      () =>
        db.asUser(
          y,
          `update public.conversation_participants set left_at = null
            where conversation_id = $1 and profile_id = $2`,
          [conversationId, y],
        ),
      /cannot_rejoin|cannot rejoin/i,
    )
  })
})
