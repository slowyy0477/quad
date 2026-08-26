/**
 * Notifications.
 *
 * The whole point of this table is that a row in it is *evidence*. "Ana endorsed
 * you for TypeScript" is only worth showing if the endorsement happened, and the
 * only way to guarantee that is for the endorsement's own trigger to be the
 * thing that wrote the notification. So the questions this file answers are, in
 * order of importance:
 *
 *   1. Can a client write, alter or aim a notification? (No: no INSERT grant, no
 *      INSERT policy, and app.create_notification() is granted to nobody.)
 *   2. Does each real event actually produce the notification it should, for the
 *      right person, and for nobody else?
 *   3. Does a notification ever carry content it should not -- most sharply, a
 *      private message's body?
 *   4. Do blocks and preferences suppress notifications, and is the one
 *      unsuppressible category genuinely unsuppressible?
 *
 * A note on the moderation tests. `moderation_status` is deliberately absent
 * from the client UPDATE grants on posts, comments and ideas, so there is no
 * such thing as a moderator issuing a bare UPDATE against it; 0015 adds an
 * audited security-definer function for that. The notification triggers fire for
 * whichever writer changes the column, so these tests drive it privileged --
 * which is exactly what that function will be.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb

let uni: string
let alice: string
let bob: string
let carol: string
let moderator: string

beforeAll(async () => {
  db = await createTestDb()

  const unis = await db.asService<{ id: string }>(
    `insert into public.universities (name, country, status)
     values ('Notify University', 'DE', 'approved') returning id`,
  )
  uni = unis[0]!.id

  alice = await db.createUser({ username: 'notify_alice', universityId: uni })
  bob = await db.createUser({ username: 'notify_bob', universityId: uni })
  carol = await db.createUser({ username: 'notify_carol', universityId: uni })
  moderator = await db.createUser({ username: 'notify_mod', universityId: uni, role: 'moderator' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

let seq = 0
/**
 * A user nobody has interacted with. Dedupe is global per
 * (recipient, type, actor, entities), so a test that counts notifications has to
 * start from someone who has none -- otherwise it is measuring the test file's
 * history rather than the trigger.
 */
async function freshUser(prefix: string): Promise<string> {
  seq += 1
  return db.createUser({ username: `${prefix}_${seq}`, universityId: uni })
}

function uniqueTitle(prefix: string) {
  seq += 1
  return `${prefix} ${seq}`
}

type Notification = {
  id: string
  recipient_id: string
  type: string
  actor_id: string | null
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
  skill_id: string | null
  achievement_key: string | null
  body: string | null
  is_read: boolean
  read_at: Date | null
  created_at: Date
}

/** Read a recipient's notifications with full privileges, to inspect what the
 *  triggers wrote rather than what the recipient is allowed to see. */
async function notifs(recipient: string): Promise<Notification[]> {
  return db.asService<Notification>(
    `select * from public.notifications where recipient_id = $1
      order by created_at, type`,
    [recipient],
  )
}

async function types(recipient: string): Promise<string[]> {
  return (await notifs(recipient)).map((n) => n.type)
}

async function notifsOf(recipient: string, type: string): Promise<Notification[]> {
  return (await notifs(recipient)).filter((n) => n.type === type)
}

/**
 * Empty someone's inbox after the fixtures are built, so that a count means what
 * it says.
 *
 * Fixture setup is not silent: creating a profile's first post earns
 * `first_post`, which is a real achievement and produces a real notification. A
 * test that asserts "the like produced one notification" would otherwise be
 * counting the achievement too, and would break again the next time an
 * achievement is defined. So the slate is wiped between arranging and acting.
 */
async function clear(...recipients: string[]): Promise<void> {
  await db.asService(`delete from public.notifications where recipient_id = any($1::uuid[])`, [
    recipients,
  ])
}

async function newPost(as: string, body = 'hello'): Promise<string> {
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.posts (author_id, body) values ($1, $2) returning id`,
    [as, body],
  )
  return rows[0]!.id
}

async function newProject(as: string, seeking = false): Promise<string> {
  seq += 1
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.projects (owner_id, title, slug, is_seeking_members)
     values ($1, $2, $3, $4) returning id`,
    [as, uniqueTitle('Notify Project'), `notify-project-${seq}`, seeking],
  )
  return rows[0]!.id
}

async function newIdea(as: string): Promise<string> {
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.ideas (author_id, title, description) values ($1, $2, $3) returning id`,
    [as, uniqueTitle('Notify Idea'), 'A description long enough to satisfy the constraint.'],
  )
  return rows[0]!.id
}

async function newEvent(
  as: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const fields: Record<string, unknown> = {
    title: uniqueTitle('Notify Workshop'),
    type: 'workshop',
    starts_at: new Date('2030-06-01T12:00:00Z').toISOString(),
    ...overrides,
  }
  const cols = Object.keys(fields)
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.events (${cols.join(', ')})
     values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(fields),
  )
  return rows[0]!.id
}

// =============================================================================

describe('the catalogue', () => {
  it('gives every type a category that exists', async () => {
    // The foreign key makes this structurally true; the assertion is here so
    // that a future migration adding a type is forced to add its category in the
    // same breath rather than discovering it at runtime.
    const orphans = await db.asService(
      `select t.type from public.notification_types t
        where not exists (
          select 1 from public.notification_categories c where c.category = t.category
        )`,
    )
    expect(orphans).toEqual([])
  })

  it('marks moderation as the only category a user cannot switch off', async () => {
    const rows = await db.asService<{ category: string }>(
      `select category from public.notification_categories where not is_suppressible`,
    )
    expect(rows.map((r) => r.category)).toEqual(['moderation'])
  })

  it('is readable without signing in, so the settings page can be rendered', async () => {
    const cats = await db.asAnon(`select category from public.notification_categories`)
    const kinds = await db.asAnon(`select type from public.notification_types`)
    expect(cats.length).toBeGreaterThan(0)
    expect(kinds.length).toBeGreaterThan(0)
  })

  it('cannot be extended by an ordinary user', async () => {
    // There is no INSERT grant at all, so this is refused before RLS is
    // consulted. Two independent reasons for the same answer is the point.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.notification_types (type, category)
           values ('you_won_a_prize', 'social')`,
        ),
      REJECTS.permissionDenied,
    )
  })

  it('cannot be re-categorised by an ordinary user', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.notification_types set category = 'social' where type = 'content_removed'`,
        ),
      REJECTS.permissionDenied,
    )
    const rows = await db.asService<{ category: string }>(
      `select category from public.notification_types where type = 'content_removed'`,
    )
    expect(rows[0]!.category).toBe('moderation')
  })
})

describe('forging a notification', () => {
  it('refuses a direct insert, even for yourself', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.notifications (recipient_id, type) values ($1, 'follow')`,
          [alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a direct insert aimed at someone else', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.notifications (recipient_id, type, actor_id, body)
           values ($1, 'content_removed', null, 'Your account will be deleted.')`,
          [bob],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a client call the writer function', async () => {
    await expectRejection(
      () =>
        db.asUser(alice, `select app.create_notification($1, 'follow', $2)`, [bob, alice]),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a recipient re-aim a notification at someone else', async () => {
    await db.asUser(bob, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      bob,
      alice,
    ])
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.notifications set recipient_id = $1 where recipient_id = $2`,
          [carol, alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a recipient rewrite what a notification says', async () => {
    await expectRejection(
      () =>
        db.asUser(alice, `update public.notifications set body = 'something else' where recipient_id = $1`, [
          alice,
        ]),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a recipient backdate a notification', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.notifications set created_at = now() - interval '1 year'
            where recipient_id = $1`,
          [alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a recipient forge a read timestamp', async () => {
    // read_at is derived from is_read by trigger. Setting it directly would let
    // a user claim they read something before it existed.
    await expectRejection(
      () =>
        db.asUser(alice, `update public.notifications set read_at = now() where recipient_id = $1`, [
          alice,
        ]),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a self-notification even from a privileged writer', async () => {
    // The constraint, not the function, is what makes this hold for a trigger
    // added later by someone who forgot the rule.
    await expectRejection(
      () =>
        db.asService(
          `insert into public.notifications (recipient_id, type, actor_id)
           values ($1, 'follow', $1)`,
          [alice],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses a type that is not in the catalogue', async () => {
    await expectRejection(
      () =>
        db.asService(
          `insert into public.notifications (recipient_id, type) values ($1, 'you_are_hired')`,
          [alice],
        ),
      REJECTS.foreignKey,
    )
  })

  it('raises rather than silently dropping an unknown type from a trigger', async () => {
    await expectRejection(
      () => db.asService(`select app.create_notification($1, 'no_such_type')`, [alice]),
      /Unknown notification type/i,
    )
  })
})

describe('reading and dismissing', () => {
  it('shows a user only their own notifications', async () => {
    const target = await freshUser('reader')
    const other = await freshUser('reader')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      other,
    ])

    const mine = await db.asUser(target, `select id from public.notifications`)
    expect(mine).toHaveLength(1)
  })

  it('hides notifications from an anonymous visitor entirely', async () => {
    // Not "returns no rows" -- anon has no SELECT privilege on the table, so the
    // question is refused rather than answered emptily.
    await expectRejection(
      () => db.asAnon(`select id from public.notifications`),
      REJECTS.permissionDenied,
    )
  })

  it('stamps read_at when a notification is marked read', async () => {
    const target = await freshUser('marker')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])

    await db.asUser(target, `update public.notifications set is_read = true where recipient_id = $1`, [
      target,
    ])

    const rows = await notifs(target)
    expect(rows[0]!.is_read).toBe(true)
    expect(rows[0]!.read_at).not.toBeNull()
  })

  it('clears read_at when a notification is marked unread again', async () => {
    const target = await freshUser('unmarker')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])

    await db.asUser(target, `update public.notifications set is_read = true where recipient_id = $1`, [
      target,
    ])
    await db.asUser(target, `update public.notifications set is_read = false where recipient_id = $1`, [
      target,
    ])

    const rows = await notifs(target)
    expect(rows[0]!.is_read).toBe(false)
    expect(rows[0]!.read_at).toBeNull()
  })

  it('does not re-stamp read_at on a row that was already read', async () => {
    const target = await freshUser('restamp')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])
    await db.asUser(target, `update public.notifications set is_read = true where recipient_id = $1`, [
      target,
    ])
    const first = (await notifs(target))[0]!.read_at

    await db.asUser(target, `update public.notifications set is_read = true where recipient_id = $1`, [
      target,
    ])
    expect((await notifs(target))[0]!.read_at).toEqual(first)
  })

  it('lets a user delete their own notification', async () => {
    const target = await freshUser('deleter')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])

    await db.asUser(target, `delete from public.notifications where recipient_id = $1`, [target])
    expect(await notifs(target)).toHaveLength(0)
  })

  it("does not let a user delete someone else's notification", async () => {
    const target = await freshUser('victim')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])

    // Filtered out by RLS, so this is a silent no-op rather than an error.
    await db.asUser(bob, `delete from public.notifications where recipient_id = $1`, [target])
    expect(await notifs(target)).toHaveLength(1)
  })

  it('does not let a moderator read a user\'s notification list', async () => {
    // Moderation works on reported content, not on someone's inbox. There is no
    // moderator branch in the select policy, and there should not be one.
    const target = await freshUser('private')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])

    const seen = await db.asUser(moderator, `select id from public.notifications where recipient_id = $1`, [
      target,
    ])
    expect(seen).toEqual([])
  })
})

describe('social graph', () => {
  it('notifies the person who was followed', async () => {
    const followed = await freshUser('followed')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      followed,
    ])

    const rows = await notifs(followed)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('follow')
    expect(rows[0]!.actor_id).toBe(alice)
  })

  it('notifies the addressee of a connection request, then the requester on acceptance', async () => {
    const requester = await freshUser('requester')
    const addressee = await freshUser('addressee')

    await db.asUser(
      requester,
      `insert into public.connections (requester_id, addressee_id) values ($1, $2)`,
      [requester, addressee],
    )
    expect(await notifsOf(addressee, 'connection_request')).toHaveLength(1)
    expect(await types(requester)).not.toContain('connection_request')

    await db.asUser(
      addressee,
      `update public.connections set status = 'accepted'
        where requester_id = $1 and addressee_id = $2`,
      [requester, addressee],
    )
    expect(await notifsOf(requester, 'connection_accepted')).toHaveLength(1)
    // The accepter already knows they accepted.
    expect(await types(addressee)).not.toContain('connection_accepted')
  })

  it('says nothing when a connection request is rejected', async () => {
    const requester = await freshUser('rejected_req')
    const addressee = await freshUser('rejecter')

    await db.asUser(
      requester,
      `insert into public.connections (requester_id, addressee_id) values ($1, $2)`,
      [requester, addressee],
    )
    await clear(requester)
    await db.asUser(
      addressee,
      `update public.connections set status = 'rejected'
        where requester_id = $1 and addressee_id = $2`,
      [requester, addressee],
    )

    // Telling someone they were turned down is a cruelty with no upside; the
    // request simply stops being pending.
    expect(await notifs(requester)).toHaveLength(0)
  })
})

describe('posts and comments', () => {
  it('notifies a post author about a like', async () => {
    const author = await freshUser('liked_author')
    const post = await newPost(author)
    await clear(author)

    await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      alice,
    ])

    const rows = await notifs(author)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('post_like')
    expect(rows[0]!.post_id).toBe(post)
    expect(rows[0]!.actor_id).toBe(alice)
  })

  it('says nothing when you like your own post', async () => {
    const author = await freshUser('self_liker')
    const post = await newPost(author)
    await clear(author)

    await db.asUser(author, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      author,
    ])
    expect(await notifs(author)).toHaveLength(0)
  })

  it('notifies a post author about a top-level comment', async () => {
    const author = await freshUser('commented_author')
    const post = await newPost(author)
    await clear(author)

    const comments = await db.asUser<{ id: string }>(
      alice,
      `insert into public.comments (post_id, author_id, body) values ($1, $2, 'Nice') returning id`,
      [post, alice],
    )

    const rows = await notifs(author)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('post_comment')
    expect(rows[0]!.post_id).toBe(post)
    expect(rows[0]!.comment_id).toBe(comments[0]!.id)
  })

  it('notifies the parent commenter about a reply, and not the post author', async () => {
    const author = await freshUser('thread_author')
    const commenter = await freshUser('thread_commenter')
    const replier = await freshUser('thread_replier')
    const post = await newPost(author)

    const parent = await db.asUser<{ id: string }>(
      commenter,
      `insert into public.comments (post_id, author_id, body) values ($1, $2, 'First') returning id`,
      [post, commenter],
    )
    await clear(author, commenter)

    await db.asUser(
      replier,
      `insert into public.comments (post_id, author_id, parent_id, body)
       values ($1, $2, $3, 'Agreed')`,
      [post, replier, parent[0]!.id],
    )

    expect(await notifsOf(commenter, 'comment_reply')).toHaveLength(1)
    // The post author heard about the top-level comment and nothing more. A busy
    // thread must not become a stream in their inbox.
    expect(await types(author)).not.toContain('post_comment')
    expect(await types(author)).not.toContain('comment_reply')
  })

  it('notifies a comment author about a like on their comment', async () => {
    const commenter = await freshUser('liked_commenter')
    const post = await newPost(alice)
    const comment = await db.asUser<{ id: string }>(
      commenter,
      `insert into public.comments (post_id, author_id, body) values ($1, $2, 'Hmm') returning id`,
      [post, commenter],
    )
    await clear(commenter)

    await db.asUser(bob, `insert into public.comment_likes (comment_id, profile_id) values ($1, $2)`, [
      comment[0]!.id,
      bob,
    ])

    const rows = await notifs(commenter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('comment_like')
    // Both anchors, so the link can open the post and reach the comment.
    expect(rows[0]!.comment_id).toBe(comment[0]!.id)
    expect(rows[0]!.post_id).toBe(post)
  })
})

describe('projects', () => {
  it('notifies the owner about a star', async () => {
    const owner = await freshUser('starred_owner')
    const project = await newProject(owner)
    await clear(owner)

    await db.asUser(alice, `insert into public.project_stars (project_id, profile_id) values ($1, $2)`, [
      project,
      alice,
    ])

    const rows = await notifs(owner)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('project_star')
    expect(rows[0]!.project_id).toBe(project)
  })

  it('notifies everyone who can act on an application, and nobody who cannot', async () => {
    const owner = await freshUser('app_owner')
    const maintainer = await freshUser('app_maintainer')
    const member = await freshUser('app_member')
    const applicant = await freshUser('app_applicant')
    const project = await newProject(owner, true)

    await db.asService(
      `insert into public.project_members (project_id, profile_id, role) values
         ($1, $2, 'maintainer'), ($1, $3, 'member')`,
      [project, maintainer, member],
    )
    await clear(owner, maintainer, member, applicant)

    await db.asUser(
      applicant,
      `insert into public.project_applications (project_id, applicant_id, message)
       values ($1, $2, 'I would like to help with the ingest pipeline.')`,
      [project, applicant],
    )

    expect(await notifsOf(owner, 'project_application')).toHaveLength(1)
    expect(await notifsOf(maintainer, 'project_application')).toHaveLength(1)
    // A plain member cannot accept or reject, so telling them is noise.
    expect(await types(member)).not.toContain('project_application')
    expect(await types(applicant)).not.toContain('project_application')
  })

  it('tells the applicant the decision, either way', async () => {
    const owner = await freshUser('decide_owner')
    const accepted = await freshUser('accepted_applicant')
    const rejected = await freshUser('rejected_applicant')
    const project = await newProject(owner, true)

    for (const applicant of [accepted, rejected]) {
      await db.asUser(
        applicant,
        `insert into public.project_applications (project_id, applicant_id, message)
         values ($1, $2, 'Happy to take the frontend work if it is still open.')`,
        [project, applicant],
      )
    }
    await clear(accepted, rejected)

    await db.asUser(
      owner,
      `update public.project_applications set status = 'accepted', reviewed_by = $1
        where project_id = $2 and applicant_id = $3`,
      [owner, project, accepted],
    )
    await db.asUser(
      owner,
      `update public.project_applications set status = 'rejected', reviewed_by = $1
        where project_id = $2 and applicant_id = $3`,
      [owner, project, rejected],
    )

    expect(await notifsOf(accepted, 'project_application_accepted')).toHaveLength(1)
    expect(await notifsOf(rejected, 'project_application_rejected')).toHaveLength(1)
  })

  it('notifies the invitee, then the inviter about the answer', async () => {
    const inviter = await freshUser('inviter')
    const invitee = await freshUser('invitee')
    const project = await newProject(inviter)

    await db.asUser(
      inviter,
      `insert into public.project_invites (project_id, invitee_id, inviter_id, message)
       values ($1, $2, $3, 'Want to join?')`,
      [project, invitee, inviter],
    )
    expect(await notifsOf(invitee, 'project_invite')).toHaveLength(1)

    await db.asUser(
      invitee,
      `update public.project_invites set status = 'accepted'
        where project_id = $1 and invitee_id = $2`,
      [project, invitee],
    )
    expect(await notifsOf(inviter, 'project_invite_accepted')).toHaveLength(1)
  })

  it('tells the existing team who joined, but not the joiner', async () => {
    const owner = await freshUser('team_owner')
    const existing = await freshUser('team_existing')
    const joiner = await freshUser('team_joiner')
    const project = await newProject(owner)

    await db.asService(
      `insert into public.project_members (project_id, profile_id, role) values ($1, $2, 'member')`,
      [project, existing],
    )
    // The existing member's own arrival notified the owner; clear the slate so
    // the next assertion is about the joiner only.
    await clear(owner, existing, joiner)

    await db.asService(
      `insert into public.project_members (project_id, profile_id, role) values ($1, $2, 'member')`,
      [project, joiner],
    )

    expect(await types(owner)).toEqual(['project_member_joined'])
    expect(await types(existing)).toEqual(['project_member_joined'])
    expect(await types(joiner)).not.toContain('project_member_joined')
  })

  it('says nothing to the owner when a project is created, because they are the only member', async () => {
    const owner = await freshUser('lonely_owner')
    await newProject(owner)
    // The owner may well have earned `first_project` for this; what they must not
    // have is a project_member_joined announcing their own arrival.
    expect(await types(owner)).not.toContain('project_member_joined')
  })

  it('tells the new owner when a project is handed over', async () => {
    const owner = await freshUser('handover_from')
    const successor = await freshUser('handover_to')
    const project = await newProject(owner)

    await db.asService(
      `insert into public.project_members (project_id, profile_id, role) values ($1, $2, 'maintainer')`,
      [project, successor],
    )
    await clear(successor)

    await db.asUser(owner, `select public.transfer_project_ownership($1, $2)`, [project, successor])

    const rows = await notifsOf(successor, 'project_ownership_received')
    expect(rows).toHaveLength(1)
    // No actor: the row records who owns the project now, not who let go of it.
    expect(rows[0]!.actor_id).toBeNull()
    expect(rows[0]!.project_id).toBe(project)
  })
})

describe('ideas', () => {
  it('notifies the author about a vote, an interest and a comment', async () => {
    const author = await freshUser('idea_author')
    const idea = await newIdea(author)
    await clear(author)

    await db.asUser(alice, `insert into public.idea_votes (idea_id, profile_id) values ($1, $2)`, [
      idea,
      alice,
    ])
    await db.asUser(
      bob,
      `insert into public.idea_interest (idea_id, profile_id, message)
       values ($1, $2, 'I have built something similar before.')`,
      [idea, bob],
    )
    await db.asUser(
      carol,
      `insert into public.idea_comments (idea_id, author_id, body) values ($1, $2, 'Good idea')`,
      [idea, carol],
    )

    const seen = await types(author)
    for (const type of ['idea_vote', 'idea_interest', 'idea_comment']) {
      expect(seen).toContain(type)
    }
  })

  it('says nothing when the author votes on their own idea', async () => {
    const author = await freshUser('self_voter')
    const idea = await newIdea(author)
    await clear(author)

    await db.asUser(author, `insert into public.idea_votes (idea_id, profile_id) values ($1, $2)`, [
      idea,
      author,
    ])
    expect(await notifs(author)).toHaveLength(0)
  })
})

describe('skills and achievements', () => {
  it('names the skill in an endorsement notification', async () => {
    const endorsed = await freshUser('endorsed')
    const skills = await db.asService<{ id: string }>(
      `insert into public.skills (name, slug, is_approved) values ($1, $2, true) returning id`,
      [uniqueTitle('Rust'), `rust-${(seq += 1)}`],
    )
    const skill = skills[0]!.id

    await db.asUser(endorsed, `insert into public.profile_skills (profile_id, skill_id) values ($1, $2)`, [
      endorsed,
      skill,
    ])
    await clear(endorsed)

    await db.asUser(
      alice,
      `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
       values ($1, $2, $3)`,
      [endorsed, skill, alice],
    )

    const rows = await notifsOf(endorsed, 'skill_endorsement')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.skill_id).toBe(skill)
    expect(rows[0]!.actor_id).toBe(alice)
  })

  it('notifies an awarded achievement with no actor', async () => {
    const earner = await freshUser('earner')
    await newPost(earner, 'first ever post')

    const rows = await notifs(earner)
    const awarded = rows.find((r) => r.type === 'achievement_awarded')
    expect(awarded).toBeDefined()
    expect(awarded!.achievement_key).toBe('first_post')
    // Nobody caused it. An achievement is the database counting, and naming a
    // person as its cause would be an invention.
    expect(awarded!.actor_id).toBeNull()
  })
})

describe('messages', () => {
  it('notifies the other participant without copying a word of the message', async () => {
    const sender = await freshUser('msg_sender')
    const recipient = await freshUser('msg_recipient')

    const conv = await db.asUser<{ start_direct_conversation: string }>(
      sender,
      `select public.start_direct_conversation($1)`,
      [recipient],
    )
    const conversation = conv[0]!.start_direct_conversation

    await db.asUser(
      sender,
      `insert into public.messages (conversation_id, sender_id, body)
       values ($1, $2, 'My bank details are 1234 5678')`,
      [conversation, sender],
    )

    const rows = await notifs(recipient)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('message')
    expect(rows[0]!.conversation_id).toBe(conversation)
    // The notification points at the conversation. It does not contain, quote or
    // preview the message, so there is exactly one place private content lives.
    expect(rows[0]!.body).toBeNull()
    expect(await notifs(sender)).toHaveLength(0)
  })

  it('collapses a burst of messages into one notification', async () => {
    const sender = await freshUser('burst_sender')
    const recipient = await freshUser('burst_recipient')
    const conv = await db.asUser<{ start_direct_conversation: string }>(
      sender,
      `select public.start_direct_conversation($1)`,
      [recipient],
    )
    const conversation = conv[0]!.start_direct_conversation

    for (const body of ['one', 'two', 'three']) {
      await db.asUser(
        sender,
        `insert into public.messages (conversation_id, sender_id, body) values ($1, $2, $3)`,
        [conversation, sender, body],
      )
    }

    expect(await notifs(recipient)).toHaveLength(1)
  })

  it('brings the notification back after it has been read', async () => {
    const sender = await freshUser('resurface_sender')
    const recipient = await freshUser('resurface_recipient')
    const conv = await db.asUser<{ start_direct_conversation: string }>(
      sender,
      `select public.start_direct_conversation($1)`,
      [recipient],
    )
    const conversation = conv[0]!.start_direct_conversation

    await db.asUser(
      sender,
      `insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hello')`,
      [conversation, sender],
    )
    await db.asUser(recipient, `update public.notifications set is_read = true where recipient_id = $1`, [
      recipient,
    ])

    await db.asUser(
      sender,
      `insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'still there?')`,
      [conversation, sender],
    )

    const rows = await notifs(recipient)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.is_read).toBe(false)
    expect(rows[0]!.read_at).toBeNull()
  })

  it('does not resurface a discrete notification that has been read', async () => {
    // The counterpart to the test above: 'follow' does not resurface, so a
    // follow, an unfollow and a re-follow cannot ring the same bell twice.
    const followed = await freshUser('refollowed')
    const follower = await freshUser('refollower')

    await db.asUser(follower, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      follower,
      followed,
    ])
    await db.asUser(followed, `update public.notifications set is_read = true where recipient_id = $1`, [
      followed,
    ])
    await db.asUser(follower, `delete from public.follows where follower_id = $1 and following_id = $2`, [
      follower,
      followed,
    ])
    await db.asUser(follower, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      follower,
      followed,
    ])

    const rows = await notifs(followed)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.is_read).toBe(true)
  })

  it('respects a muted conversation', async () => {
    const sender = await freshUser('muted_sender')
    const recipient = await freshUser('muted_recipient')
    const conv = await db.asUser<{ start_direct_conversation: string }>(
      sender,
      `select public.start_direct_conversation($1)`,
      [recipient],
    )
    const conversation = conv[0]!.start_direct_conversation

    await db.asUser(
      recipient,
      `update public.conversation_participants set is_muted = true
        where conversation_id = $1 and profile_id = $2`,
      [conversation, recipient],
    )

    await db.asUser(
      sender,
      `insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hi')`,
      [conversation, sender],
    )

    expect(await notifs(recipient)).toHaveLength(0)

    // Muting stops the interruption, not the delivery: the message and its
    // unread count are still there when the user opens the conversation.
    const unread = await db.asService<{ unread_count: number }>(
      `select unread_count from public.conversation_participants
        where conversation_id = $1 and profile_id = $2`,
      [conversation, recipient],
    )
    expect(unread[0]!.unread_count).toBe(1)
  })
})

describe('events', () => {
  it('tells everyone who was going or interested that an event was cancelled', async () => {
    const organiser = await freshUser('cancel_organiser')
    const going = await freshUser('cancel_going')
    const interested = await freshUser('cancel_interested')
    const uninvolved = await freshUser('cancel_bystander')
    const event = await newEvent(organiser)

    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      event,
      going,
    ])
    await db.asUser(
      interested,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'interested')`,
      [event, interested],
    )

    await db.asUser(organiser, `update public.events set status = 'cancelled' where id = $1`, [event])

    expect(await types(going)).toEqual(['event_cancelled'])
    expect(await types(interested)).toEqual(['event_cancelled'])
    expect(await types(uninvolved)).toEqual([])
  })

  it('tells only the confirmed attendees about a change of time', async () => {
    const organiser = await freshUser('move_organiser')
    const going = await freshUser('move_going')
    const interested = await freshUser('move_interested')
    const event = await newEvent(organiser)

    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      event,
      going,
    ])
    await db.asUser(
      interested,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'interested')`,
      [event, interested],
    )

    await db.asUser(
      organiser,
      `update public.events set starts_at = $2 where id = $1`,
      [event, new Date('2030-06-02T12:00:00Z').toISOString()],
    )

    expect(await types(going)).toEqual(['event_rescheduled'])
    // "Interested" is not a commitment; a time change is not yet their problem.
    expect(await types(interested)).toEqual([])
  })

  it('notifies again on a second reschedule', async () => {
    const organiser = await freshUser('move2_organiser')
    const going = await freshUser('move2_going')
    const event = await newEvent(organiser)
    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      event,
      going,
    ])

    await db.asUser(organiser, `update public.events set starts_at = $2 where id = $1`, [
      event,
      new Date('2030-06-03T12:00:00Z').toISOString(),
    ])
    await db.asUser(going, `update public.notifications set is_read = true where recipient_id = $1`, [going])
    await db.asUser(organiser, `update public.events set starts_at = $2 where id = $1`, [
      event,
      new Date('2030-06-04T12:00:00Z').toISOString(),
    ])

    const rows = await notifs(going)
    expect(rows).toHaveLength(1)
    // The second move matters as much as the first, so the row resurfaces.
    expect(rows[0]!.is_read).toBe(false)
  })

  it('does not announce a time change on an event that is already cancelled', async () => {
    const organiser = await freshUser('dead_organiser')
    const going = await freshUser('dead_going')
    const event = await newEvent(organiser)
    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      event,
      going,
    ])
    await db.asUser(organiser, `update public.events set status = 'cancelled' where id = $1`, [event])
    await db.asService(`delete from public.notifications where recipient_id = $1`, [going])

    await db.asUser(organiser, `update public.events set starts_at = $2 where id = $1`, [
      event,
      new Date('2030-07-01T12:00:00Z').toISOString(),
    ])

    expect(await types(going)).toEqual([])
  })
})

describe('moderation decisions', () => {
  it('tells an author their post was removed, without naming the moderator', async () => {
    const author = await freshUser('moderated_author')
    const post = await newPost(author, 'something that got reported')
    await db.asService(`delete from public.notifications where recipient_id = $1`, [author])

    await db.asService(`update public.posts set moderation_status = 'removed' where id = $1`, [post])

    const rows = await notifs(author)
    expect(rows.map((r) => r.type)).toEqual(['content_removed'])
    // No actor. Naming the moderator invites retaliation and gives the author
    // nothing they can act on; the appeal route is the report, not the person.
    expect(rows[0]!.actor_id).toBeNull()
    expect(rows[0]!.post_id).toBe(post)
  })

  it('distinguishes hidden from removed', async () => {
    const author = await freshUser('hidden_author')
    const post = await newPost(author, 'pending review')
    await db.asService(`delete from public.notifications where recipient_id = $1`, [author])

    await db.asService(`update public.posts set moderation_status = 'hidden' where id = $1`, [post])
    expect(await types(author)).toEqual(['content_hidden'])
  })

  it('says nothing when content is restored', async () => {
    const author = await freshUser('restored_author')
    const post = await newPost(author, 'wrongly reported')
    await db.asService(`update public.posts set moderation_status = 'hidden' where id = $1`, [post])
    await db.asService(`delete from public.notifications where recipient_id = $1`, [author])

    await db.asService(`update public.posts set moderation_status = 'active' where id = $1`, [post])
    // The content simply reappears. There is nothing to tell.
    expect(await types(author)).toEqual([])
  })

  it('covers every moderated surface, not just posts', async () => {
    const author = await freshUser('multi_author')
    const post = await newPost(author, 'a post')
    const idea = await newIdea(author)
    const event = await newEvent(author)
    const comment = await db.asUser<{ id: string }>(
      author,
      `insert into public.comments (post_id, author_id, body) values ($1, $2, 'a comment') returning id`,
      [await newPost(alice), author],
    )
    await db.asService(`delete from public.notifications where recipient_id = $1`, [author])

    await db.asService(`update public.posts set moderation_status = 'removed' where id = $1`, [post])
    await db.asService(`update public.ideas set moderation_status = 'removed' where id = $1`, [idea])
    await db.asService(`update public.events set moderation_status = 'removed' where id = $1`, [event])
    await db.asService(`update public.comments set moderation_status = 'removed' where id = $1`, [
      comment[0]!.id,
    ])

    const rows = await notifs(author)
    expect(rows.filter((r) => r.type === 'content_removed')).toHaveLength(4)
    expect(rows.find((r) => r.idea_id === idea)).toBeDefined()
    expect(rows.find((r) => r.event_id === event)).toBeDefined()
    expect(rows.find((r) => r.comment_id === comment[0]!.id)).toBeDefined()
  })

  it('reaches a user who has switched off every category they are allowed to', async () => {
    const author = await freshUser('silent_author')
    const post = await newPost(author, 'contentious')

    const suppressible = await db.asService<{ category: string }>(
      `select category from public.notification_categories where is_suppressible`,
    )
    for (const { category } of suppressible) {
      await db.asUser(
        author,
        `insert into public.notification_preferences (profile_id, category, in_app_enabled)
         values ($1, $2, false)`,
        [author, category],
      )
    }
    await db.asService(`delete from public.notifications where recipient_id = $1`, [author])

    await db.asService(`update public.posts set moderation_status = 'removed' where id = $1`, [post])

    // Being told your own content was removed is not marketing.
    expect(await types(author)).toEqual(['content_removed'])
  })
})

describe('deduplication', () => {
  it('collapses an unlike and a re-like into the notification that already exists', async () => {
    const author = await freshUser('dedupe_author')
    const post = await newPost(author)
    await clear(author)

    for (let i = 0; i < 3; i += 1) {
      await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
        post,
        alice,
      ])
      await db.asUser(alice, `delete from public.post_likes where post_id = $1 and profile_id = $2`, [
        post,
        alice,
      ])
    }
    await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      alice,
    ])

    expect(await notifs(author)).toHaveLength(1)
  })

  it('keeps two different people separate', async () => {
    const author = await freshUser('two_likers')
    const post = await newPost(author)
    await clear(author)

    for (const liker of [alice, bob]) {
      await db.asUser(liker, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
        post,
        liker,
      ])
    }

    const rows = await notifs(author)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set([alice, bob]))
  })

  it('keeps the same person on two different posts separate', async () => {
    const author = await freshUser('two_posts')
    const first = await newPost(author, 'one')
    const second = await newPost(author, 'two')

    for (const post of [first, second]) {
      await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
        post,
        alice,
      ])
    }

    expect((await notifs(author)).filter((r) => r.type === 'post_like')).toHaveLength(2)
  })
})

describe('blocking', () => {
  it('does not create a notification from someone the recipient has blocked', async () => {
    const blocker = await freshUser('blocker')
    const blocked = await freshUser('blocked')
    await db.asUser(blocker, `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [
      blocker,
      blocked,
    ])

    const post = await newPost(blocker)
    await clear(blocker)
    // A block does not make the blocked user's likes impossible in every path;
    // whatever reaches the table must not reach the inbox.
    await db.asService(`insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      blocked,
    ])

    expect(await notifs(blocker)).toHaveLength(0)
  })

  it('works in the other direction too', async () => {
    const blocker = await freshUser('blocker2')
    const blocked = await freshUser('blocked2')
    await db.asUser(blocker, `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [
      blocker,
      blocked,
    ])

    const post = await newPost(blocked)
    await clear(blocked)
    await db.asService(`insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      blocker,
    ])

    expect(await notifs(blocked)).toHaveLength(0)
  })

  it('withdraws notifications that already existed when the block is created', async () => {
    const blocker = await freshUser('retro_blocker')
    const nuisance = await freshUser('retro_nuisance')

    await db.asUser(nuisance, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      nuisance,
      blocker,
    ])
    expect(await notifs(blocker)).toHaveLength(1)

    await db.asUser(blocker, `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [
      blocker,
      nuisance,
    ])

    // Otherwise the blocker keeps a list item naming the person they just
    // blocked, and can still click through to them from it.
    expect(await notifs(blocker)).toHaveLength(0)
  })
})

describe('preferences', () => {
  it('treats a missing row as enabled', async () => {
    const target = await freshUser('default_prefs')
    const prefs = await db.asService(
      `select category from public.notification_preferences where profile_id = $1`,
      [target],
    )
    expect(prefs).toEqual([])

    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      target,
    ])
    expect(await types(target)).toEqual(['follow'])
  })

  it('suppresses only the category that was switched off', async () => {
    const target = await freshUser('selective_prefs')
    await db.asUser(
      target,
      `insert into public.notification_preferences (profile_id, category, in_app_enabled)
       values ($1, 'engagement', false)`,
      [target],
    )

    const post = await newPost(target)
    await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      alice,
    ])
    await db.asUser(bob, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      bob,
      target,
    ])

    const seen = await types(target)
    expect(seen).toContain('follow')
    expect(seen).not.toContain('post_like')
  })

  it('refuses to switch off a category that is not suppressible', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.notification_preferences (profile_id, category, in_app_enabled)
           values ($1, 'moderation', false)`,
          [alice],
        ),
      /cannot be switched off/i,
    )
  })

  it('allows the non-suppressible category to be explicitly left on', async () => {
    const target = await freshUser('explicit_on')
    await db.asUser(
      target,
      `insert into public.notification_preferences (profile_id, category, in_app_enabled)
       values ($1, 'moderation', true)`,
      [target],
    )
    const rows = await db.asService(
      `select category from public.notification_preferences
        where profile_id = $1 and category = 'moderation'`,
      [target],
    )
    expect(rows).toHaveLength(1)
  })

  it('rewrites a preference forged for someone else to the caller', async () => {
    // The established pattern: a forged owner column is made inert rather than
    // rejected, so a probe learns nothing from the response.
    const victim = await freshUser('pref_victim')
    await db.asUser(
      alice,
      `insert into public.notification_preferences (profile_id, category, in_app_enabled)
       values ($1, 'social', false)`,
      [victim],
    )

    const victimRows = await db.asService(
      `select 1 from public.notification_preferences where profile_id = $1`,
      [victim],
    )
    expect(victimRows).toEqual([])

    const aliceRows = await db.asService<{ in_app_enabled: boolean }>(
      `select in_app_enabled from public.notification_preferences
        where profile_id = $1 and category = 'social'`,
      [alice],
    )
    expect(aliceRows[0]!.in_app_enabled).toBe(false)

    // Leave the shared fixture as it was.
    await db.asService(`delete from public.notification_preferences where profile_id = $1`, [alice])
  })

  it("does not let a user read someone else's preferences", async () => {
    const target = await freshUser('pref_private')
    await db.asUser(
      target,
      `insert into public.notification_preferences (profile_id, category, in_app_enabled)
       values ($1, 'messages', false)`,
      [target],
    )

    const seen = await db.asUser(bob, `select category from public.notification_preferences where profile_id = $1`, [
      target,
    ])
    expect(seen).toEqual([])
  })

  it('refuses a category that does not exist', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.notification_preferences (profile_id, category)
           values ($1, 'telepathy')`,
          [alice],
        ),
      /Unknown notification category/i,
    )
  })
})

describe('the unread count', () => {
  it("counts the caller's unread notifications and nobody else's", async () => {
    const target = await freshUser('counter')
    await clear(target)
    for (const actor of [alice, bob, carol]) {
      await db.asUser(actor, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
        actor,
        target,
      ])
    }

    let count = await db.asUser<{ unread_notification_count: number }>(
      target,
      `select public.unread_notification_count()`,
    )
    expect(count[0]!.unread_notification_count).toBe(3)

    await db.asUser(
      target,
      `update public.notifications set is_read = true where recipient_id = $1 and actor_id = $2`,
      [target, alice],
    )
    count = await db.asUser<{ unread_notification_count: number }>(
      target,
      `select public.unread_notification_count()`,
    )
    expect(count[0]!.unread_notification_count).toBe(2)

    // Nobody can point the function at anyone: it takes no argument.
    const bystander = await freshUser('non_counter')
    const other = await db.asUser<{ unread_notification_count: number }>(
      bystander,
      `select public.unread_notification_count()`,
    )
    expect(other[0]!.unread_notification_count).toBe(0)
  })

  it('is not callable by an anonymous visitor', async () => {
    await expectRejection(
      () => db.asAnon(`select public.unread_notification_count()`),
      REJECTS.permissionDenied,
    )
  })
})

describe('cleanup', () => {
  it('takes a notification with the thing it pointed at', async () => {
    const author = await freshUser('cascade_author')
    const post = await newPost(author)
    await db.asUser(alice, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
      post,
      alice,
    ])
    expect((await notifs(author)).some((r) => r.post_id === post)).toBe(true)

    await db.asService(`delete from public.posts where id = $1`, [post])

    // A typed foreign key rather than a polymorphic id, precisely so that a
    // hard delete cannot leave a notification pointing at nothing.
    expect((await notifs(author)).some((r) => r.post_id === post)).toBe(false)
  })

  it('takes a notification with the recipient', async () => {
    const doomed = await freshUser('doomed')
    await db.asUser(alice, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      alice,
      doomed,
    ])
    await db.asService(`delete from auth.users where id = $1`, [doomed])

    const rows = await db.asService(`select id from public.notifications where recipient_id = $1`, [
      doomed,
    ])
    expect(rows).toEqual([])
  })
})

describe('scheduled reminders', () => {
  it('is not callable by a signed-in user', async () => {
    // A user who could run the sweep could use it to find out whether a listing
    // they cannot see exists.
    await expectRejection(
      () => db.asUser(alice, `select public.dispatch_due_reminders()`),
      REJECTS.permissionDenied,
    )
  })

  it('reminds confirmed attendees of an event that is close, and only once', async () => {
    const organiser = await freshUser('reminder_organiser')
    const going = await freshUser('reminder_going')
    const interested = await freshUser('reminder_interested')

    const soon = await newEvent(organiser, {
      starts_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    })
    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      soon,
      going,
    ])
    await db.asUser(
      interested,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'interested')`,
      [soon, interested],
    )

    const first = await db.asService<{ dispatch_due_reminders: number }>(
      `select public.dispatch_due_reminders()`,
    )
    expect(first[0]!.dispatch_due_reminders).toBeGreaterThanOrEqual(1)
    expect(await types(going)).toContain('event_reminder')
    expect(await types(interested)).not.toContain('event_reminder')

    // Running the sweep again creates nothing: idempotence is the dedupe
    // constraint's job, so a crashed run can simply be repeated.
    const before = (await notifs(going)).length
    await db.asService(`select public.dispatch_due_reminders()`)
    expect((await notifs(going)).length).toBe(before)
  })

  it('leaves an event that is still far away alone', async () => {
    const organiser = await freshUser('far_organiser')
    const going = await freshUser('far_going')
    const later = await newEvent(organiser, {
      starts_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await db.asUser(going, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [
      later,
      going,
    ])

    await db.asService(`select public.dispatch_due_reminders()`)
    expect(await types(going)).not.toContain('event_reminder')
  })

  it('reminds whoever saved an opportunity whose deadline is close', async () => {
    const poster = await freshUser('deadline_poster')
    const saver = await freshUser('deadline_saver')

    const opportunities = await db.asUser<{ id: string }>(
      poster,
      `insert into public.opportunities
         (title, organisation, description, type, apply_url, deadline)
       values ($1, 'Kleinbetrieb GmbH',
               'Six months building an ingest pipeline. Rust or Go.',
               'internship', 'https://example.test/apply', $2)
       returning id`,
      [uniqueTitle('Closing Internship'), new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()],
    )
    const opportunity = opportunities[0]!.id

    await db.asUser(
      saver,
      `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
      [opportunity, saver],
    )

    await db.asService(`select public.dispatch_due_reminders()`)

    const rows = await notifs(saver)
    const reminder = rows.find((r) => r.type === 'opportunity_deadline')
    expect(reminder).toBeDefined()
    expect(reminder!.opportunity_id).toBe(opportunity)
    // A save is private from the poster, and so is the reminder about it.
    expect(await types(poster)).not.toContain('opportunity_deadline')
  })
})
