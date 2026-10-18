/**
 * Moderation, sanctions and rate limiting — permission tests.
 *
 * 0020 and 0021 are the launch blocker DEPLOYMENT.md names ("Moderation.
 * 0016_moderation is not written", "Rate limiting. 0017_rate_limits is not
 * written"). Writing the migration is not the fix for that; these tests are. A
 * moderation table with no test is a moderator queue nobody has proved refuses
 * anything, and the failure it hides is invisible: a policy that permits too much
 * looks exactly like a policy that works, until it is exercised by a client that
 * is not the interface.
 *
 * So every property below is the one an attacker with the anon key would go for,
 * asserted in the three-direction shape (the owner can; a stranger cannot; a
 * stranger cannot by substituting an id):
 *
 *   1. a report cannot be filed twice by the same reader against the same target;
 *   2. a client cannot set status or reviewer fields directly;
 *   3. a moderator action without a reason fails at the database level;
 *   4. an action row cannot be deleted -- or edited -- by a moderator;
 *   5. a moderator cannot decide a report about themselves, and cannot sanction
 *      an administrator;
 *   6. a non-moderator cannot read the queue, cannot read the audit log, and
 *      cannot call the action function;
 *   7. a suspended account cannot post;
 *   8. the fixed window boundary: the Nth call succeeds and the N+1th is refused.
 *
 * The database is PGlite (PostgreSQL 18 in WebAssembly) with the real migrations
 * applied, and `asUser` switches to the `authenticated` role with a JWT `sub`
 * claim, so what these tests exercise is the actual policy, not a model of it.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb

let reader: string      // files reports
let author: string      // writes the content that gets reported
let stranger: string    // the unrelated signed-in user, used for the "cannot" half
let moderator: string
let admin: string
let otherAdmin: string
let universityId: string

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('mod-uni', 'Moderation Test University', 'approved') returning id`,
  )
  universityId = uni[0]!.id

  reader = await db.createUser({ username: 'reporter_one', universityId })
  author = await db.createUser({ username: 'posting_author', universityId })
  stranger = await db.createUser({ username: 'bystander', universityId })
  moderator = await db.createUser({ username: 'queue_mod', role: 'moderator' })
  admin = await db.createUser({ username: 'site_owner', role: 'admin' })
  otherAdmin = await db.createUser({ username: 'site_owner2', role: 'admin' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** A public post by the given user. */
async function createPost(userId: string, body = 'Reported content'): Promise<string> {
  const rows = await db.asUser<{ id: string }>(
    userId,
    `insert into public.posts (body, visibility) values ($1, 'public') returning id`,
    [body],
  )
  return rows[0]!.id
}

/** A report as `reporter`, returning its id. */
async function fileReport(
  reporterId: string,
  kind: string,
  targetColumn: string,
  targetId: string,
  reason = 'Harassment or bullying',
): Promise<string> {
  const rows = await db.asUser<{ id: string }>(
    reporterId,
    `insert into public.reports (kind, reason, ${targetColumn})
     values ($1, $2, $3) returning id`,
    [kind, reason, targetId],
  )
  return rows[0]!.id
}

/** A direct conversation between two users, created with full privileges. */
async function conversationBetween(a: string, b: string): Promise<string> {
  const conv = await db.asService<{ id: string }>(
    `insert into public.conversations (type, created_by, pair_low, pair_high)
     values ('direct', $1, least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid))
     returning id`,
    [a, b],
  )
  const id = conv[0]!.id
  await db.asService(
    `insert into public.conversation_participants (conversation_id, profile_id, role)
     values ($1, $2, 'member'), ($1, $3, 'member')`,
    [id, a, b],
  )
  return id
}

// ---------------------------------------------------------------------------

describe('filing a report', () => {
  it('assigns the reporter from the session, not from the request', async () => {
    const postId = await createPost(author)

    // No reporter_id is sent -- it is not in the INSERT grant and the BEFORE
    // trigger would overwrite it. That the insert succeeds at all is the proof
    // the trigger assigned it, because the column is NOT NULL.
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    const rows = await db.asService<{ reporter_id: string; status: string; kind: string }>(
      `select reporter_id, status, kind from public.reports where id = $1`,
      [reportId],
    )
    expect(rows[0]!.reporter_id).toBe(reader)
    expect(rows[0]!.status).toBe('open')
    expect(rows[0]!.kind).toBe('post')
  })

  it('refuses reporter_id, status and the reviewer fields from a client', async () => {
    const postId = await createPost(author)

    // The forgery a report form would be attacked with: claim the report was
    // filed by someone else, or file it already decided.
    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason, post_id, reporter_id)
           values ('post', 'Harassment or bullying', $1, $2)`,
          [postId, stranger],
        ),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason, post_id, status)
           values ('post', 'Harassment or bullying', $1, 'dismissed')`,
          [postId],
        ),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason, post_id, reviewed_by, reviewed_at)
           values ('post', 'Harassment or bullying', $1, $2, now())`,
          [postId, moderator],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a second open report by the same reader against the same target', async () => {
    const postId = await createPost(author)
    await fileReport(reader, 'post', 'post_id', postId)

    // A second identical complaint produces the same queue item and a second
    // identical decision, so the partial unique index refuses it rather than
    // letting the queue be flooded by one reader with one grudge.
    await expectRejection(
      () => fileReport(reader, 'post', 'post_id', postId),
      REJECTS.uniqueViolation,
    )

    // A different reader may report the same thing: it is a second opinion, not
    // a duplicate.
    await fileReport(stranger, 'post', 'post_id', postId)

    const rows = await db.asService<{ n: number }>(
      `select count(*)::int as n from public.reports where post_id = $1`,
      [postId],
    )
    expect(rows[0]!.n).toBe(2)
  })

  it('allows a fresh report once the previous one has been decided', async () => {
    // The index is partial on status = 'open' on purpose: a situation that
    // recurs after a dismissal is a new situation, and the earlier decision is
    // still in the log.
    const postId = await createPost(author)
    const first = await fileReport(reader, 'post', 'post_id', postId)

    await db.asUser(moderator, `select public.moderate_report($1, 'dismiss_report', $2)`, [
      first,
      'Nothing here breaks a rule.',
    ])

    const second = await fileReport(reader, 'post', 'post_id', postId)
    expect(second).toBeTruthy()
  })

  it('refuses a report with no target, or a target that does not match its kind', async () => {
    // Exactly one target: none at all.
    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason) values ('post', 'Harassment or bullying')`,
        ),
      REJECTS.checkViolation,
    )

    const postId = await createPost(author)

    // ...and a kind that disagrees with the column that is set. Without this a
    // report could be filed as 'message' while carrying a post_id, and the queue
    // would render public content under a heading that says a private message
    // was reported.
    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason, post_id)
           values ('message', 'Harassment or bullying', $1)`,
          [postId],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses reporting yourself', async () => {
    await expectRejection(
      () =>
        db.asUser(
          reader,
          `insert into public.reports (kind, reason, user_id)
           values ('profile', 'Harassment or bullying', $1)`,
          [reader],
        ),
      /cannot report yourself/i,
    )
  })
})

describe('reading a report', () => {
  it('shows a report to its reporter and to nobody else', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    const own = await db.asUser(reader, `select id from public.reports where id = $1`, [reportId])
    expect(own).toHaveLength(1)

    // A stranger sees nothing in a list...
    const listed = await db.asUser(
      stranger,
      `select id from public.reports where post_id = $1`,
      [postId],
    )
    expect(listed).toEqual([])

    // ...and nothing by substituting the id, which is the attack a policy that
    // filters only on the query would miss.
    const byId = await db.asUser(stranger, `select id from public.reports where id = $1`, [
      reportId,
    ])
    expect(byId).toEqual([])
  })

  it('gives a moderator the whole queue', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    const rows = await db.asUser(
      moderator,
      `select id from public.reports where id = $1`,
      [reportId],
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses a signed-out visitor everything', async () => {
    await expectRejection(
      () => db.asAnon(`select id from public.reports limit 1`),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () => db.asAnon(`select id from public.moderation_actions limit 1`),
      REJECTS.permissionDenied,
    )
  })

  it('lets a moderator read a reported message and nothing beside it', async () => {
    // The privacy trade SECURITY.md §8 describes: 0010 deliberately has no
    // blanket moderator read on private messages, and left the narrow policy to
    // the moderation migration because a policy expression cannot reference a
    // table that does not exist yet.
    const conversationId = await conversationBetween(reader, author)
    const messages = await db.asUser<{ id: string }>(
      author,
      `insert into public.messages (conversation_id, body) values ($1, $2) returning id`,
      [conversationId, 'the reported message'],
    )
    const reported = messages[0]!.id
    await db.asUser(
      author,
      `insert into public.messages (conversation_id, body) values ($1, 'a private message nobody complained about')`,
      [conversationId],
    )

    // Precondition, so the assertion below is not vacuous: the moderator cannot
    // read the conversation before anything is reported.
    const before = await db.asUser(
      moderator,
      `select id from public.messages where conversation_id = $1`,
      [conversationId],
    )
    expect(before).toEqual([])

    await fileReport(reader, 'message', 'message_id', reported)

    const after = await db.asUser<{ id: string; body: string }>(
      moderator,
      `select id, body from public.messages where conversation_id = $1`,
      [conversationId],
    )
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(reported)
  })
})

describe('deciding a report', () => {
  it('refuses any client UPDATE of status, and refuses DELETE outright', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    // The moderator is the one who would benefit from this, and cannot.
    await expectRejection(
      () =>
        db.asUser(
          moderator,
          `update public.reports set status = 'dismissed' where id = $1`,
          [reportId],
        ),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () => db.asUser(reader, `delete from public.reports where id = $1`, [reportId]),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () => db.asUser(moderator, `delete from public.reports where id = $1`, [reportId]),
      REJECTS.permissionDenied,
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.reports where id = $1`,
      [reportId],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('records the action, hides the content, and tells the reporter', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await db.asUser(moderator, `select public.moderate_report($1, 'hide_content', $2)`, [
      reportId,
      'Thinly veiled abuse aimed at a classmate.',
    ])

    const report = await db.asService<{ status: string; reviewed_by: string }>(
      `select status, reviewed_by from public.reports where id = $1`,
      [reportId],
    )
    expect(report[0]!.status).toBe('actioned')
    expect(report[0]!.reviewed_by).toBe(moderator)

    const post = await db.asService<{ moderation_status: string }>(
      `select moderation_status from public.posts where id = $1`,
      [postId],
    )
    expect(post[0]!.moderation_status).toBe('hidden')

    const action = await db.asService<{
      actor_id: string
      action: string
      reason: string
      target_profile_id: string
      report_id: string
    }>(
      `select actor_id, action, reason, target_profile_id, report_id
         from public.moderation_actions where report_id = $1`,
      [reportId],
    )
    expect(action).toHaveLength(1)
    expect(action[0]!.actor_id).toBe(moderator)
    expect(action[0]!.action).toBe('hide_content')
    expect(action[0]!.reason).toContain('classmate')
    expect(action[0]!.target_profile_id).toBe(author)

    // The report dialog promises the reporter they will hear about it, so the
    // database has to keep that promise rather than the copy claiming it does.
    // Keyed on the post, not just on the recipient: a second report about
    // something else is a second line, and this asserts one per report.
    const notified = await db.asService<{ type: string; body: string }>(
      `select type, body from public.notifications
        where recipient_id = $1 and type = 'report_reviewed' and post_id = $2`,
      [reader, postId],
    )
    expect(notified).toHaveLength(1)
    expect(notified[0]!.body).toContain('acted')
  })

  it('refuses an action with no reason', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await expectRejection(
      () => db.asUser(moderator, `select public.moderate_report($1, 'hide_content', '   ')`, [reportId]),
      /needs a reason/i,
    )

    await expectRejection(
      () =>
        db.asUser(
          moderator,
          `select public.moderate_report($1, 'hide_content', null)`,
          [reportId],
        ),
      /needs a reason/i,
    )

    // Unchanged: the refusal is not a partial write.
    const post = await db.asService<{ moderation_status: string }>(
      `select moderation_status from public.posts where id = $1`,
      [postId],
    )
    expect(post[0]!.moderation_status).toBe('active')
  })

  it('refuses a status change that has no recorded reason, even with full privileges', async () => {
    // The chokepoint. A service-role statement bypasses RLS, so the only thing
    // standing between "closed the report" and "no record of why" is the trigger.
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await expectRejection(
      () =>
        db.asService(
          `update public.reports set status = 'dismissed', reviewed_by = $1, reviewed_at = now()
            where id = $2`,
          [admin, reportId],
        ),
      /recorded reason/i,
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.reports where id = $1`,
      [reportId],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('refuses an action row with no reason at the table level', async () => {
    // Two mechanisms, tested separately: the RPC's own check above, and the
    // column constraint here, so a future writer that skips the RPC is still
    // refused.
    await expectRejection(
      () =>
        db.asService(
          `insert into public.moderation_actions (actor_id, action, reason)
           values ($1, 'warn_user', '   ')`,
          [moderator],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses a second decision on the same report', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await db.asUser(moderator, `select public.moderate_report($1, 'dismiss_report', $2)`, [
      reportId,
      'Off-topic rather than a rule breach.',
    ])

    await expectRejection(
      () =>
        db.asUser(moderator, `select public.moderate_report($1, 'hide_content', $2)`, [
          reportId,
          'Changed my mind about the first decision.',
        ]),
      /already been decided/i,
    )
  })

  it('refuses a non-moderator calling the action function', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    // The reporter may not decide their own report, and the unrelated user may
    // not decide anything. Neither of them can reach the queue at all.
    await expectRejection(
      () =>
        db.asUser(reader, `select public.moderate_report($1, 'hide_content', $2)`, [
          reportId,
          'I will decide my own complaint, thank you.',
        ]),
      /moderator privileges/i,
    )

    await expectRejection(
      () =>
        db.asUser(stranger, `select public.moderate_report($1, 'hide_content', $2)`, [
          reportId,
          'Trying my luck.',
        ]),
      /moderator privileges/i,
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.reports where id = $1`,
      [reportId],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('refuses a moderator a report about themselves, even to dismiss it', async () => {
    const moderatorPost = await createPost(moderator, 'A post by the moderator')
    const reportId = await fileReport(reader, 'post', 'post_id', moderatorPost)

    await expectRejection(
      () =>
        db.asUser(moderator, `select public.moderate_report($1, 'dismiss_report', $2)`, [
          reportId,
          'This complaint about me is unfounded.',
        ]),
      /about yourself/i,
    )

    // Another moderator still can, which is what keeps the report from being
    // unclosable rather than merely undecidable by one person. Admin is
    // moderator-or-above, so this also covers that direction.
    await db.asUser(admin, `select public.moderate_report($1, 'dismiss_report', $2)`, [
      reportId,
      'Reviewed by a second moderator; no rule was broken.',
    ])

    const rows = await db.asService<{ status: string }>(
      `select status from public.reports where id = $1`,
      [reportId],
    )
    expect(rows[0]!.status).toBe('dismissed')
  })

  it('refuses a moderator a report against an administrator', async () => {
    const adminPost = await createPost(admin, 'A post by an administrator')
    const reportId = await fileReport(reader, 'post', 'post_id', adminPost)

    await expectRejection(
      () =>
        db.asUser(moderator, `select public.moderate_report($1, 'suspend_user', $2)`, [
          reportId,
          'Suspending an administrator from a moderator account.',
        ]),
      /administrator/i,
    )

    // Their account is untouched, which is the point: the refusal is before the
    // write, not after it.
    const profile = await db.asService<{ status: string }>(
      `select status from public.profiles where id = $1`,
      [admin],
    )
    expect(profile[0]!.status).toBe('active')

    // A second administrator can decide it -- the rule blocks a moderator, not
    // the queue.
    await db.asUser(otherAdmin, `select public.moderate_report($1, 'dismiss_report', $2)`, [
      reportId,
      'Discussed with the other administrator; no action needed.',
    ])
  })
})

describe('the audit log', () => {
  it('refuses a moderator every write of any kind', async () => {
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await db.asUser(moderator, `select public.moderate_report($1, 'hide_content', $2)`, [
      reportId,
      'Repeated harassment of one student.',
    ])

    const action = await db.asService<{ id: string; reason: string }>(
      `select id, reason from public.moderation_actions where report_id = $1`,
      [reportId],
    )
    const actionId = action[0]!.id

    // An audit log a moderator can edit is not an audit log, and an audit log a
    // moderator can delete is not a record at all. Both attempts are refused,
    // and the row is still there afterwards with its original reason.
    await expectRejection(
      () => db.asUser(moderator, `delete from public.moderation_actions where id = $1`, [actionId]),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () =>
        db.asUser(
          moderator,
          `update public.moderation_actions set reason = 'nothing to see here' where id = $1`,
          [actionId],
        ),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () =>
        db.asUser(
          moderator,
          `insert into public.moderation_actions (actor_id, action, reason)
           values ($1, 'warn_user', 'A decision I did not make, attributed to me.')`,
          [moderator],
        ),
      REJECTS.permissionDenied,
    )

    const rows = await db.asService<{ reason: string }>(
      `select reason from public.moderation_actions where id = $1`,
      [actionId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toContain('harassment')
  })

  it('records a correction as a second row rather than an edit', async () => {
    // The supersede path, which is the only way to change a decision.
    const postId = await createPost(author)
    const reportId = await fileReport(reader, 'post', 'post_id', postId)

    await db.asUser(moderator, `select public.moderate_report($1, 'hide_content', $2)`, [
      reportId,
      'Hidden pending a second opinion.',
    ])

    const first = await db.asService<{ id: string }>(
      `select id from public.moderation_actions where report_id = $1`,
      [reportId],
    )
    const firstId = first[0]!.id

    await db.asService(
      `insert into public.moderation_actions (actor_id, action, reason, report_id, supersedes_id)
       values ($1, 'restore_content', $2, $3, $4)`,
      [admin, 'Restored: the second opinion was that this broke no rule.', reportId, firstId],
    )

    const rows = await db.asService<{ id: string; action: string; supersedes_id: string | null }>(
      `select id, action, supersedes_id from public.moderation_actions
        where report_id = $1 order by created_at`,
      [reportId],
    )
    expect(rows).toHaveLength(2)
    // The original is unchanged and still says what it said. A log with the
    // earlier entry removed is a log that agrees with whoever wrote last.
    expect(rows[0]!.id).toBe(firstId)
    expect(rows[0]!.action).toBe('hide_content')
    expect(rows[0]!.supersedes_id).toBeNull()
    expect(rows[1]!.supersedes_id).toBe(firstId)
  })

  it('shows the log to moderators and to nobody else', async () => {
    const visibleToModerator = await db.asUser(
      moderator,
      `select id from public.moderation_actions limit 5`,
    )
    expect(visibleToModerator.length).toBeGreaterThan(0)

    // A stranger gets an empty list rather than an error: the table is granted
    // to `authenticated` and the policy does the filtering, which is the same
    // shape every other table in this schema uses.
    const visibleToStranger = await db.asUser(
      stranger,
      `select id from public.moderation_actions limit 5`,
    )
    expect(visibleToStranger).toEqual([])
  })
})

describe('account sanctions', () => {
  it('stops a suspended account posting, and lets it post again once the suspension ends', async () => {
    const offender = await db.createUser({ username: 'suspended_student', universityId })

    // It can post to begin with. Without this the test below proves nothing.
    await createPost(offender, 'An ordinary post')

    const reportId = await fileReport(reader, 'profile', 'user_id', offender)
    await db.asUser(moderator, `select public.moderate_report($1, 'suspend_user', $2, 7)`, [
      reportId,
      'Third time this week that a classmate has been targeted.',
    ])

    const profile = await db.asService<{
      status: string
      suspended_until: string | null
      suspension_reason: string | null
    }>(
      `select status, suspended_until, suspension_reason from public.profiles where id = $1`,
      [offender],
    )
    expect(profile[0]!.status).toBe('suspended')
    expect(profile[0]!.suspended_until).not.toBeNull()
    expect(profile[0]!.suspension_reason).toContain('classmate')

    // The enforcement, in the database rather than in the interface: a direct
    // PostgREST call skips the action wrapper entirely, so a suspension the
    // wrapper alone enforced would not be a suspension.
    await expectRejection(
      () =>
        db.asUser(offender, `insert into public.posts (body, visibility) values ('Still talking', 'public')`),
      /suspended/i,
    )

    const otherPost = await createPost(author, 'Somebody else\u2019s post')

    await expectRejection(
      () =>
        db.asUser(
          offender,
          `insert into public.comments (post_id, body) values ($1, 'Still talking')`,
          [otherPost],
        ),
      /suspended/i,
    )

    // Lapsed is not suspended. The column keeps saying 'suspended' -- nothing
    // clears it -- and the predicate compares the expiry to now(), so the state
    // is derived rather than maintained by a second writer that can disagree.
    await db.asService(
      `update public.profiles set suspended_until = now() - interval '1 minute' where id = $1`,
      [offender],
    )
    await createPost(offender, 'Back after the suspension lapsed')
  })

  it('counts a warning without restricting the account', async () => {
    const warned = await db.createUser({ username: 'warned_student', universityId })
    const before = await db.asService<{ warning_count: number }>(
      `select warning_count from public.profiles where id = $1`,
      [warned],
    )
    expect(before[0]!.warning_count).toBe(0)

    const reportId = await fileReport(reader, 'profile', 'user_id', warned)
    await db.asUser(moderator, `select public.moderate_report($1, 'warn_user', $2)`, [
      reportId,
      'First warning for a rude reply.',
    ])

    const after = await db.asService<{ warning_count: number; status: string }>(
      `select warning_count, status from public.profiles where id = $1`,
      [warned],
    )
    expect(after[0]!.warning_count).toBe(1)
    expect(after[0]!.status).toBe('active')
  })

  it('refuses a client writing its own status back to active', async () => {
    // The column is not in the UPDATE grant, and the protected-column trigger is
    // the second barrier. A suspension a suspended user can lift is not one.
    const offender = await db.createUser({ username: 'limbo_student', universityId })
    const reportId = await fileReport(reader, 'profile', 'user_id', offender)
    await db.asUser(moderator, `select public.moderate_report($1, 'suspend_user', $2)`, [
      reportId,
      'Suspended while an incident is looked into.',
    ])

    await expectRejection(
      () =>
        db.asUser(offender, `update public.profiles set status = 'active' where id = $1`, [offender]),
      REJECTS.permissionDenied,
    )
  })
})

describe('university requests', () => {
  it('refuses a non-moderator approving anything, and lets a moderator decide', async () => {
    const requested = await db.asService<{ id: string }>(
      `insert into public.universities (slug, name, submitted_by)
       values ('requested-uni', 'Requested University', $1) returning id`,
      [reader],
    )
    const uniId = requested[0]!.id

    await expectRejection(
      () =>
        db.asUser(
          reader,
          `select public.review_university_request($1, 'approve', 'I would like my university listed.')`,
          [uniId],
        ),
      /moderator privileges/i,
    )

    // The protected-column trigger would refuse this even with a policy in
    // place, which is why approval is an RPC rather than an UPDATE. Note which
    // layer refuses: `authenticated` does hold an UPDATE grant on this table, and
    // the refusal comes from the trigger, not from the GRANT -- so a future
    // `grant update (status)` added for some other reason would still not be
    // enough to approve anything.
    await expectRejection(
      () =>
        db.asUser(
          moderator,
          `update public.universities set status = 'approved' where id = $1`,
          [uniId],
        ),
      /cannot be modified|permission denied/i,
    )

    await db.asUser(
      moderator,
      `select public.review_university_request($1, 'approve', $2)`,
      [uniId, 'Confirmed against the national register of institutions.'],
    )

    const row = await db.asService<{ status: string; reviewed_by: string }>(
      `select status, reviewed_by from public.universities where id = $1`,
      [uniId],
    )
    expect(row[0]!.status).toBe('approved')
    expect(row[0]!.reviewed_by).toBe(moderator)

    const action = await db.asService<{ action: string; university_id: string }>(
      `select action, university_id from public.moderation_actions where university_id = $1`,
      [uniId],
    )
    expect(action).toHaveLength(1)
    expect(action[0]!.action).toBe('approve_university')
  })
})

describe('bug reports', () => {
  it('is readable by its author and by administrators, and not by anybody else', async () => {
    const rows = await db.asUser<{ id: string }>(
      reader,
      `insert into public.bug_reports (title, body, page_url)
       values ('The feed does not load on my phone', 'It shows an empty page after I sign in.', '/feed')
       returning id`,
    )
    const bugId = rows[0]!.id

    const bugs = await db.asService<{ reporter_id: string; status: string }>(
      `select reporter_id, status from public.bug_reports where id = $1`,
      [bugId],
    )
    expect(bugs[0]!.reporter_id).toBe(reader)
    expect(bugs[0]!.status).toBe('open')

    const own = await db.asUser(reader, `select id from public.bug_reports where id = $1`, [bugId])
    expect(own).toHaveLength(1)

    const asStranger = await db.asUser(
      stranger,
      `select id from public.bug_reports where id = $1`,
      [bugId],
    )
    expect(asStranger).toEqual([])

    // The maintainer. Not moderators: a bug report contains the environment
    // somebody was using, and the smallest set that can act on it is the right
    // one.
    const asAdmin = await db.asUser(admin, `select id from public.bug_reports where id = $1`, [bugId])
    expect(asAdmin).toHaveLength(1)

    const asModerator = await db.asUser(
      moderator,
      `select id from public.bug_reports where id = $1`,
      [bugId],
    )
    expect(asModerator).toEqual([])
  })

  it('lets an administrator advance the status and nobody else', async () => {
    const rows = await db.asUser<{ id: string }>(
      reader,
      `insert into public.bug_reports (title, body)
       values ('The streak is wrong after a missed day', 'It counted a day I did not log.')
       returning id`,
    )
    const bugId = rows[0]!.id

    const readStatus = async () => {
      const current = await db.asService<{ status: string }>(
        `select status from public.bug_reports where id = $1`,
        [bugId],
      )
      return current[0]!.status
    }

    // The column is granted to `authenticated` -- a grant is per role, not per
    // user -- so the refusal here is row-level security, and an UPDATE that no
    // policy permits succeeds having changed nothing. That is the shape of an
    // RLS refusal on UPDATE and it is why this asserts the stored value rather
    // than an error: "it threw" and "it changed nothing" are different, and only
    // one of them is a defence.
    await db.asUser(reader, `update public.bug_reports set status = 'fixed' where id = $1`, [bugId])
    expect(await readStatus()).toBe('open')

    await db.asUser(stranger, `update public.bug_reports set status = 'closed' where id = $1`, [
      bugId,
    ])
    expect(await readStatus()).toBe('open')

    // A moderator is not an administrator. The maintainer is the one who triages.
    await db.asUser(moderator, `update public.bug_reports set status = 'closed' where id = $1`, [
      bugId,
    ])
    expect(await readStatus()).toBe('open')

    // The maintainer can. This is the control the list view renders, and it is
    // the only column anyone may change.
    await db.asUser(admin, `update public.bug_reports set status = 'reviewed' where id = $1`, [bugId])
    expect(await readStatus()).toBe('reviewed')

    // ...and only that column. `title` and `body` are outside the grant for every
    // client role, including an administrator: a report that can be rewritten
    // after it has been read is not a report.
    await expectRejection(
      () =>
        db.asUser(admin, `update public.bug_reports set body = 'edited' where id = $1`, [bugId]),
      REJECTS.permissionDenied,
    )

    // The author cannot rewrite their own report either.
    await expectRejection(
      () =>
        db.asUser(reader, `update public.bug_reports set body = 'edited' where id = $1`, [bugId]),
      REJECTS.permissionDenied,
    )

    // No deletion path exists, for anyone but a migration.
    await expectRejection(
      () => db.asUser(admin, `delete from public.bug_reports where id = $1`, [bugId]),
      REJECTS.permissionDenied,
    )
  })
})

describe('rate limiting (0021)', () => {
  it('lets the Nth call through in a window and refuses the N+1th', async () => {
    // A fresh bucket per test so the window cannot be shared with another case,
    // and a one-hour window so the boundary cannot move mid-test.
    //
    // Sequential, not Promise.all: the harness drives one Postgres session and
    // each call switches role and sets a claim first, so concurrent calls would
    // interleave those statements rather than the decisions under test.
    const limit = 3
    const allowed: boolean[] = []

    for (let i = 0; i < 4; i += 1) {
      const rows = await db.asUser<{ allowed: boolean }>(
        stranger,
        `select public.check_rate_limit('test:boundary', $1, 3600) as allowed`,
        [limit],
      )
      allowed.push(rows[0]!.allowed)
    }

    // The Nth call in the window succeeds and the N+1th does not. Off by one in
    // either direction is the classic limiter bug: one lets everybody through,
    // the other refuses the last legitimate call.
    expect(allowed).toEqual([true, true, true, false])
  })

  it('counts each bucket and each user separately', async () => {
    const first = await db.asUser<{ allowed: boolean }>(
      stranger,
      `select public.check_rate_limit('test:bucket-a', 1, 3600) as allowed`,
    )
    expect(first[0]!.allowed).toBe(true)

    // Same user, same window, different surface: a different budget.
    const otherBucket = await db.asUser<{ allowed: boolean }>(
      stranger,
      `select public.check_rate_limit('test:bucket-b', 1, 3600) as allowed`,
    )
    expect(otherBucket[0]!.allowed).toBe(true)

    // Same surface, a different user: a different budget too, or one person
    // reporting would use up everybody else's.
    const otherUser = await db.asUser<{ allowed: boolean }>(
      reader,
      `select public.check_rate_limit('test:bucket-a', 1, 3600) as allowed`,
    )
    expect(otherUser[0]!.allowed).toBe(true)

    // ...and the first bucket is now spent for the first user.
    const spent = await db.asUser<{ allowed: boolean }>(
      stranger,
      `select public.check_rate_limit('test:bucket-a', 1, 3600) as allowed`,
    )
    expect(spent[0]!.allowed).toBe(false)
  })

  it('keeps the counter, so a refused call does not reset the window', async () => {
    for (let i = 0; i < 2; i += 1) {
      const rows = await db.asUser<{ allowed: boolean }>(
        reader,
        `select public.check_rate_limit('test:sticky', 2, 3600) as allowed`,
      )
      expect(rows[0]!.allowed).toBe(true)
    }

    for (let i = 0; i < 3; i += 1) {
      const rows = await db.asUser<{ allowed: boolean }>(
        reader,
        `select public.check_rate_limit('test:sticky', 2, 3600) as allowed`,
      )
      expect(rows[0]!.allowed).toBe(false)
    }
  })

  it('refuses an anonymous caller, an out-of-range limit and an out-of-range window', async () => {
    // No identity, no budget: a limit keyed on a value the client chooses is not
    // a limit, and every surface this protects needs a session anyway.
    await expectRejection(
      () => db.asAnon(`select public.check_rate_limit('test:anon', 5, 60)`),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () => db.asUser(reader, `select public.check_rate_limit('test:zero-limit', 0, 60)`),
      /out of range/i,
    )

    await expectRejection(
      () => db.asUser(reader, `select public.check_rate_limit('test:long-window', 5, 999999)`),
      /out of range/i,
    )

    await expectRejection(
      () => db.asUser(reader, `select public.check_rate_limit('   ', 5, 60)`),
      /bucket name/i,
    )
  })

  it('hides the limiter itself from every client', async () => {
    // The public wrapper is the only door. app.* is not served by PostgREST, and
    // these assertions are what keep that true if a grant is ever widened.
    await expectRejection(
      () => db.asUser(reader, `select app.check_rate_limit('test:direct', 5, 60)`),
      REJECTS.permissionDenied,
    )

    await expectRejection(
      () => db.asAnon(`select app.check_rate_limit('test:direct', 5, 60)`),
      REJECTS.permissionDenied,
    )

    // The ledger is not readable: it would be a list of what other people have
    // been doing.
    await expectRejection(
      () => db.asUser(reader, `select hits from app.rate_limit_windows limit 1`),
      REJECTS.permissionDenied,
    )
  })
})

/**
 * Security headers, and the launch gate on crawling.
 *
 * Not a database test, and it lives here anyway because this file is the proof
 * for the whole workstream and docs/plan/issues.json asks for "a test asserts the
 * headers are present". A rendered-response assertion would need a running server,
 * which `npm test` does not have; asserting on the exported policy is the part
 * that can be checked in CI, and the remaining gap — that the header is attached
 * to a real response — is named in the workstream report rather than glossed over.
 */
describe('security headers', () => {
  it('sets the headers DEPLOYMENT.md lists', async () => {
    const { securityHeaders } = await import('../../next.config')
    const byKey = new Map(securityHeaders().map((header) => [header.key, header.value]))

    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff')
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(byKey.get('X-Frame-Options')).toBe('DENY')
    expect(byKey.get('Permissions-Policy')).toContain('camera=()')
    expect(byKey.get('Permissions-Policy')).toContain('microphone=()')

    // Not set, deliberately, and asserted so that it is added at launch with the
    // domain rather than by habit: HSTS is a promise about a hostname.
    expect(byKey.has('Strict-Transport-Security')).toBe(false)
  })

  it('carries a policy whose one exception is named', async () => {
    const { contentSecurityPolicy } = await import('../../next.config')
    const csp = contentSecurityPolicy()

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain('connect-src')
    expect(csp).toContain("img-src 'self' data: blob:")

    // The invariant that matters: `'unsafe-inline'` appears in script-src (Next's
    // streamed flight payload, explained at length in next.config.ts) and in
    // style-src (Tailwind and Radix inline styles), and nowhere else. If a third
    // directive ever gains it, this fails and the reason has to be written down.
    const loosened = csp
      .split('; ')
      .filter((directive) => directive.includes("'unsafe-inline'"))
      .map((directive) => directive.split(' ')[0])
      .sort()

    expect(loosened).toEqual(['script-src', 'style-src'])
  })

  it('tells crawlers to stay away until the launch state says otherwise', async () => {
    const [{ default: robots }, { LAUNCH_STATE, isIndexable }] = await Promise.all([
      import('@/app/robots'),
      import('@/features/admin/launch-state'),
    ])

    // src/app/layout.tsx sets robots.index = false and this must agree with it.
    // The day it does not, the site is either half-indexed or invisible, and both
    // are discovered late.
    expect(LAUNCH_STATE.launched).toBe(false)
    expect(isIndexable()).toBe(false)

    const manifest = robots()
    expect(manifest.rules).toEqual([{ userAgent: '*', disallow: ['/'] }])
    // No sitemap line before launch: advertising URLs on a site that refuses
    // crawling is a contradiction a crawler resolves the wrong way.
    expect(manifest.sitemap).toBeUndefined()
  })
})
