/**
 * Direct-SQL regressions for participant self-promotion and reports that unlock
 * private messages. All authorization assertions run as actual client roles;
 * fixtures use the existing PGlite harness, never a live Supabase project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let universityId: string
let conversationAdmin: string
let member: string
let outsider: string
let moderator: string

const ROLE_CHANGE_REFUSED = /only a conversation admin may change participant roles/i
const TARGET_NOT_VISIBLE = /you can only report something you can see/i

const OTHER_TARGETS = [
  { kind: 'post', table: 'posts', column: 'post_id' },
  { kind: 'comment', table: 'comments', column: 'comment_id' },
  { kind: 'project', table: 'projects', column: 'project_id' },
  { kind: 'idea', table: 'ideas', column: 'idea_id' },
  { kind: 'profile', table: 'profiles', column: 'user_id' },
] as const
const MESSAGE_TARGET = { kind: 'message', table: 'messages', column: 'message_id' } as const
type ReportTarget = (typeof OTHER_TARGETS)[number] | typeof MESSAGE_TARGET

beforeAll(async () => {
  db = await createTestDb()
  const universities = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('authorization-uni', 'Authorization Test University', 'approved')
     returning id`,
  )
  universityId = universities[0]!.id
  conversationAdmin = await db.createUser({ username: 'authz_group_admin', universityId })
  member = await db.createUser({ username: 'authz_member', universityId })
  outsider = await db.createUser({ username: 'authz_outsider' })
  moderator = await db.createUser({ username: 'authz_moderator', role: 'moderator' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function createGroup(members = [member]): Promise<string> {
  // Positive group fixtures have the explicit accepted consent now required by 0035.
  for (const candidate of members) {
    await db.asService(
      `insert into public.connections (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now()) on conflict do nothing`,
      [conversationAdmin, candidate],
    )
  }
  const rows = await db.asUser<{ create_group_conversation: string }>(
    conversationAdmin,
    `select public.create_group_conversation($1, $2::uuid[])`,
    ['Authorization regression group', members],
  )
  return rows[0]!.create_group_conversation
}

async function createThread() {
  const conversationId = await createGroup()
  const messages = await db.asUser<{ id: string }>(
    conversationAdmin,
    `insert into public.messages (conversation_id, body)
     values ($1, 'Reported message fixture'), ($1, 'Unreported adjacent fixture')
     returning id`,
    [conversationId],
  )
  return { conversationId, messageId: messages[0]!.id, adjacentId: messages[1]!.id }
}

async function fileReport(actor: string, target: ReportTarget, targetId: string) {
  // Identifiers come only from the fixed descriptors above, never client input.
  const rows = await db.asUser<{ id: string }>(
    actor,
    `insert into public.reports (kind, reason, ${target.column})
     values ($1, 'Harassment or bullying', $2) returning id`,
    [target.kind, targetId],
  )
  return rows[0]!.id
}

async function expectUnreadableReportRejected(
  actor: string,
  target: ReportTarget,
  targetId: string,
) {
  const error = await expectRejection(
    () => fileReport(actor, target, targetId),
    TARGET_NOT_VISIBLE,
  )
  expect(error).toMatchObject({ code: '42501', hint: 'report_target_not_visible' })
}

async function createOtherTarget(kind: (typeof OTHER_TARGETS)[number]['kind']): Promise<string> {
  if (kind === 'profile') {
    return db.createUser({ universityId, visibility: 'university' })
  }

  let sql: string
  let params: unknown[] = []
  switch (kind) {
    case 'post':
      sql = `insert into public.posts (body, visibility)
             values ('University report fixture', 'university') returning id`
      break
    case 'comment':
      params = [await createOtherTarget('post')]
      sql = `insert into public.comments (post_id, body)
             values ($1, 'University comment fixture') returning id`
      break
    case 'project':
      sql = `insert into public.projects (title, description, category, visibility)
             values ('University report project', 'A project for authorization regression tests.',
                     'web', 'university') returning id`
      break
    case 'idea':
      sql = `insert into public.ideas (title, description, category, visibility)
             values ('University report idea', 'An idea for authorization regression tests.',
                     'web', 'university') returning id`
      break
  }
  const rows = await db.asUser<{ id: string }>(conversationAdmin, sql, params)
  return rows[0]!.id
}

describe('conversation participant role authorization', () => {
  it('refuses direct self-promotion by an ordinary group member', async () => {
    const conversationId = await createGroup()
    const error = await expectRejection(
      () => db.asUser(
        member,
        `update public.conversation_participants set role = 'admin'
          where conversation_id = $1 and profile_id = $2`,
        [conversationId, member],
      ),
      ROLE_CHANGE_REFUSED,
    )
    expect(error).toMatchObject({ code: '42501', hint: 'participant_role_change_not_permitted' })
    const rows = await db.asUser<{ role: string }>(
      member,
      `select role from public.conversation_participants
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, member],
    )
    expect(rows).toEqual([{ role: 'member' }])
    expect(await db.asUser(
      member,
      `update public.conversations set title = 'Unauthorized title' where id = $1 returning id`,
      [conversationId],
    )).toEqual([])
  })

  it('rolls back a role change bundled with an otherwise valid self-update', async () => {
    const conversationId = await createGroup()
    await expectRejection(
      () => db.asUser(
        member,
        `update public.conversation_participants
            set role = 'admin', is_muted = true, last_read_at = now()
          where conversation_id = $1 and profile_id = $2`,
        [conversationId, member],
      ),
      ROLE_CHANGE_REFUSED,
    )
    expect(await db.asUser(
      member,
      `select role, is_muted, last_read_at from public.conversation_participants
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, member],
    )).toEqual([{ role: 'member', is_muted: false, last_read_at: null }])
  })

  it('also refuses self-promotion in a direct conversation', async () => {
    const rows = await db.asUser<{ start_direct_conversation: string }>(
      conversationAdmin,
      `select public.start_direct_conversation($1)`,
      [member],
    )
    await expectRejection(
      () => db.asUser(
        member,
        `update public.conversation_participants set role = 'admin'
          where conversation_id = $1 and profile_id = $2`,
        [rows[0]!.start_direct_conversation, member],
      ),
      ROLE_CHANGE_REFUSED,
    )
  })

  it('preserves ordinary self read-state, mute and leave updates', async () => {
    const conversationId = await createGroup()
    expect(await db.asUser(
      member,
      `update public.conversation_participants
          set role = 'member', last_read_at = now(), is_muted = true
        where conversation_id = $1 and profile_id = $2
        returning role, is_muted, last_read_at is not null as has_read`,
      [conversationId, member],
    )).toEqual([{ role: 'member', is_muted: true, has_read: true }])
    expect(await db.asUser(
      member,
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1 and profile_id = $2
        returning left_at is not null as has_left`,
      [conversationId, member],
    )).toEqual([{ has_left: true }])
  })

  it('does not let a member change another participant role by substituting their id', async () => {
    const conversationId = await createGroup()
    expect(await db.asUser(
      member,
      `update public.conversation_participants set role = 'member'
        where conversation_id = $1 and profile_id = $2 returning profile_id`,
      [conversationId, conversationAdmin],
    )).toEqual([])
    expect(await db.asUser(
      conversationAdmin,
      `select role from public.conversation_participants
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, conversationAdmin],
    )).toEqual([{ role: 'admin' }])
  })

  it.each(['outsider', 'moderator'] as const)(
    'does not give an unrelated %s role-update access from a known conversation id',
    async (actorName) => {
      const actor = actorName === 'outsider' ? outsider : moderator
      const conversationId = await createGroup()
      expect(await db.asUser(
        actor,
        `update public.conversation_participants set role = 'admin'
          where conversation_id = $1 and profile_id = $2 returning profile_id`,
        [conversationId, member],
      )).toEqual([])
      expect(await db.asUser(
        conversationAdmin,
        `select role from public.conversation_participants
          where conversation_id = $1 and profile_id = $2`,
        [conversationId, member],
      )).toEqual([{ role: 'member' }])
    },
  )

  it('does not mistake a site moderator who is a member for a conversation admin', async () => {
    const conversationId = await createGroup([member, moderator])
    await expectRejection(
      () => db.asUser(
        moderator,
        `update public.conversation_participants set role = 'admin'
          where conversation_id = $1 and profile_id = $2`,
        [conversationId, moderator],
      ),
      ROLE_CHANGE_REFUSED,
    )
  })

  it('preserves admin promotions, demotions, removals, reinvitations and additions', async () => {
    const conversationId = await createGroup()
    for (const role of ['admin', 'member']) {
      expect(await db.asUser(
        conversationAdmin,
        `update public.conversation_participants set role = $3
          where conversation_id = $1 and profile_id = $2 returning role`,
        [conversationId, member, role],
      )).toEqual([{ role }])
      if (role === 'admin') {
        expect(await db.asUser(
          member,
          `update public.conversations set title = 'Legitimate admin title'
            where id = $1 returning id`,
          [conversationId],
        )).toEqual([{ id: conversationId }])
      }
    }
    for (const leave of [true, false]) {
      expect(await db.asUser(
        conversationAdmin,
        `update public.conversation_participants
            set left_at = case when $3::boolean then now() else null end
          where conversation_id = $1 and profile_id = $2
          returning left_at is not null as has_left`,
        [conversationId, member, leave],
      )).toEqual([{ has_left: leave }])
    }
    const invitee = await db.createUser()
    await db.asService(
      `insert into public.connections (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now())`,
      [conversationAdmin, invitee],
    )
    expect(await db.asUser(
      conversationAdmin,
      `insert into public.conversation_participants (conversation_id, profile_id, role)
       values ($1, $2, 'member') returning profile_id`,
      [conversationId, invitee],
    )).toEqual([{ profile_id: invitee }])
  })

  it('allows admin handoff and self-demotion but does not let the demoted user promote back', async () => {
    const conversationId = await createGroup()
    await db.asUser(
      conversationAdmin,
      `update public.conversation_participants set role = 'admin'
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, member],
    )
    expect(await db.asUser(
      conversationAdmin,
      `update public.conversation_participants set role = 'member'
        where conversation_id = $1 and profile_id = $2 returning role`,
      [conversationId, conversationAdmin],
    )).toEqual([{ role: 'member' }])
    await expectRejection(
      () => db.asUser(
        conversationAdmin,
        `update public.conversation_participants set role = 'admin'
          where conversation_id = $1 and profile_id = $2`,
        [conversationId, conversationAdmin],
      ),
      ROLE_CHANGE_REFUSED,
    )
  })
})

describe('report target authorization', () => {
  it('refuses a known unreadable message UUID without unlocking moderator SELECT', async () => {
    const { conversationId, messageId } = await createThread()
    for (const actor of [outsider, moderator]) {
      expect(await db.asUser(
        actor, `select id from public.messages where id = $1`, [messageId],
      )).toEqual([])
    }

    // Capture the whole exploit even on the pre-fix schema: a successful INSERT
    // must be followed by checking whether it opened the moderator read path.
    let rejection: unknown
    try {
      await fileReport(outsider, MESSAGE_TARGET, messageId)
    } catch (error) {
      rejection = error
    }
    expect(await db.asUser(
      moderator,
      `select id, body from public.messages where conversation_id = $1`,
      [conversationId],
    )).toEqual([])
    expect(rejection).toMatchObject({ code: '42501', hint: 'report_target_not_visible' })
    expect((rejection as Error).message).toMatch(TARGET_NOT_VISIBLE)
    expect(await db.asUser(
      outsider, `select id from public.reports where message_id = $1`, [messageId],
    )).toEqual([])
  })

  it('does not let an unrelated moderator self-file a report to unlock a private message', async () => {
    const { messageId } = await createThread()
    await expectUnreadableReportRejected(moderator, MESSAGE_TARGET, messageId)
    expect(await db.asUser(
      moderator, `select id from public.messages where id = $1`, [messageId],
    )).toEqual([])
  })

  it('preserves participant reports and narrow moderator reads, including after a decision', async () => {
    const { conversationId, messageId, adjacentId } = await createThread()
    const reportId = await fileReport(member, MESSAGE_TARGET, messageId)
    expect(await db.asUser(
      member, `select reporter_id, status from public.reports where id = $1`, [reportId],
    )).toEqual([{ reporter_id: member, status: 'open' }])
    expect(await db.asUser(
      moderator,
      `select id from public.messages where conversation_id = $1`,
      [conversationId],
    )).toEqual([{ id: messageId }])
    expect(await db.asUser(
      moderator, `select id from public.messages where id = $1`, [adjacentId],
    )).toEqual([])
    expect(await db.asUser(
      moderator, `select id from public.conversations where id = $1`, [conversationId],
    )).toEqual([])
    expect(await db.asUser(
      moderator,
      `select profile_id from public.conversation_participants where conversation_id = $1`,
      [conversationId],
    )).toEqual([])
    await expectUnreadableReportRejected(outsider, MESSAGE_TARGET, messageId)

    expect(await db.asUser(
      moderator,
      `select public.moderate_report($1, 'dismiss_report', 'Reviewed regression fixture')`,
      [reportId],
    )).toEqual([{ moderate_report: 'dismissed' }])
    expect(await db.asUser(
      moderator, `select action from public.moderation_actions where report_id = $1`, [reportId],
    )).toEqual([{ action: 'dismiss_report' }])
    expect(await db.asUser(
      moderator, `select id from public.messages where conversation_id = $1`, [conversationId],
    )).toEqual([{ id: messageId }])
  })

  it('lets a moderator report a message already readable through a legitimate report', async () => {
    const { messageId } = await createThread()
    await fileReport(member, MESSAGE_TARGET, messageId)
    const reportId = await fileReport(moderator, MESSAGE_TARGET, messageId)
    expect(await db.asUser(
      moderator, `select reporter_id from public.reports where id = $1`, [reportId],
    )).toEqual([{ reporter_id: moderator }])
  })

  it('uses existing history readability for a participant who has left', async () => {
    const { conversationId, messageId } = await createThread()
    await db.asUser(
      member,
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1 and profile_id = $2`,
      [conversationId, member],
    )
    // No new departed-user cutoff: eligibility follows the existing SELECT.
    expect(await db.asUser(
      member, `select id from public.messages where id = $1`, [messageId],
    )).toEqual([{ id: messageId }])
    expect(await fileReport(member, MESSAGE_TARGET, messageId)).toBeTruthy()
  })

  it.each(['hidden', 'removed'])(
    'refuses reporting an unreadable %s message but preserves the sender read exception',
    async (status) => {
      const { messageId } = await createThread()
      await db.asService(
        `update public.messages set moderation_status = $2 where id = $1`,
        [messageId, status],
      )
      expect(await db.asUser(
        member, `select id from public.messages where id = $1`, [messageId],
      )).toEqual([])
      await expectUnreadableReportRejected(member, MESSAGE_TARGET, messageId)
      expect(await db.asUser(
        conversationAdmin, `select id from public.messages where id = $1`, [messageId],
      )).toEqual([{ id: messageId }])
      expect(await fileReport(conversationAdmin, MESSAGE_TARGET, messageId)).toBeTruthy()
    },
  )

  it.each(OTHER_TARGETS)(
    'enforces existing $kind readability for outsiders, legitimate readers and moderators',
    async (target) => {
      const targetId = await createOtherTarget(target.kind)
      expect(await db.asUser(
        outsider, `select id from public.${target.table} where id = $1`, [targetId],
      )).toEqual([])
      await expectUnreadableReportRejected(outsider, target, targetId)
      expect(await db.asUser(
        member, `select id from public.${target.table} where id = $1`, [targetId],
      )).toEqual([{ id: targetId }])
      expect(await fileReport(member, target, targetId)).toBeTruthy()
      expect(await fileReport(moderator, target, targetId)).toBeTruthy()
    },
  )

  it('checks comment visibility, not just its readable parent post', async () => {
    const commentId = await createOtherTarget('comment')
    const comments = await db.asUser<{ post_id: string }>(
      conversationAdmin, `select post_id from public.comments where id = $1`, [commentId],
    )
    const postId = comments[0]!.post_id
    await db.asService(
      `update public.comments set moderation_status = 'hidden' where id = $1`,
      [commentId],
    )
    expect(await db.asUser(
      member, `select id from public.posts where id = $1`, [postId],
    )).toEqual([{ id: postId }])
    expect(await db.asUser(
      member, `select id from public.comments where id = $1`, [commentId],
    )).toEqual([])
    const commentTarget = OTHER_TARGETS[1]
    await expectUnreadableReportRejected(member, commentTarget, commentId)
    expect(await fileReport(moderator, commentTarget, commentId)).toBeTruthy()
  })

  it.each([...OTHER_TARGETS, MESSAGE_TARGET])(
    'rejects nonexistent $kind targets with the same refusal as unreadable targets',
    async (target) => {
      await expectUnreadableReportRejected(
        member, target, '00000000-0000-4000-8000-000000000000',
      )
    },
  )

  it('leaves malformed target shapes and self-profile reports to the existing constraints', async () => {
    await expectRejection(
      () => db.asUser(
        member, `insert into public.reports (kind, reason) values ('post', 'Harassment')`,
      ),
      REJECTS.checkViolation,
    )
    const postId = await createOtherTarget('post')
    await expectRejection(
      () => db.asUser(
        member,
        `insert into public.reports (kind, reason, post_id)
         values ('message', 'Harassment', $1)`,
        [postId],
      ),
      REJECTS.checkViolation,
    )
    const { messageId } = await createThread()
    await expectRejection(
      () => db.asUser(
        member,
        `insert into public.reports (kind, reason, post_id, message_id)
         values ('post', 'Harassment', $1, $2)`,
        [postId, messageId],
      ),
      REJECTS.checkViolation,
    )
    await expectRejection(
      () => fileReport(member, OTHER_TARGETS[4], member),
      /you cannot report yourself/i,
    )
  })

  it('retains the reporter and reviewer column-grant defenses', async () => {
    const { messageId } = await createThread()
    await expectRejection(
      () => db.asUser(
        outsider,
        `insert into public.reports (kind, reason, message_id, reporter_id)
         values ('message', 'Harassment', $1, $2)`,
        [messageId, member],
      ),
      REJECTS.permissionDenied,
    )
    await expectRejection(
      () => db.asUser(
        member,
        `insert into public.reports (kind, reason, message_id, reviewed_by, reviewed_at, status)
         values ('message', 'Harassment', $1, $2, now(), 'dismissed')`,
        [messageId, moderator],
      ),
      REJECTS.permissionDenied,
    )
  })
})

describe('guard function execute privileges', () => {
  it('keeps both guards uncallable by authenticated and anonymous clients', async () => {
    const sql = `select
      has_function_privilege(current_user, 'app.conversation_participants_before_write()', 'EXECUTE')
        as participant_guard,
      has_function_privilege(current_user, 'app.reports_before_write()', 'EXECUTE')
        as report_guard`
    const denied = [{ participant_guard: false, report_guard: false }]
    expect(await db.asUser(member, sql)).toEqual(denied)
    expect(await db.asAnon(sql)).toEqual(denied)
  })
})
