/**
 * Ideas domain permission tests.
 *
 * An idea is the front half of the project lifecycle, and it carries authorisation
 * surface of its own: who wrote it, who may change or close it, who may say they would
 * help, and what happens to all three when the idea becomes a project.
 *
 * The properties here are the ones a client could otherwise talk its way past:
 *
 *   * authorship is decided by the database, not by what the form sent;
 *   * an offer of help is one person's and cannot be made on someone else's behalf;
 *   * a vote is one per person;
 *   * a hidden idea is invisible to everyone but its author;
 *   * project updates belong to members;
 *   * a conversion happens once, carries the interested people across, and cannot be
 *     run twice.
 *
 * Each of those is checked in three directions, as in projects.test.ts: the person who
 * should be able to does, an unrelated person cannot, and an unrelated person who
 * substitutes the owner's own id still cannot.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let universityId: string
let skillId: string

let author: string
let helper: string
let helper2: string
let outsider: string
let classmate: string

const PITCH = 'A shared timetable for lab groups, so nobody turns up to an empty room.'

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('ideas-uni', 'Ideas University', 'approved') returning id`,
  )
  universityId = uni[0]!.id

  const skill = await db.asService<{ id: string }>(
    `insert into public.skills (name, slug, category, is_approved)
     values ('TypeScript', 'typescript-ideas-test', 'language', true) returning id`,
  )
  skillId = skill[0]!.id

  author = await db.createUser({ username: 'idea_author', universityId })
  helper = await db.createUser({ username: 'idea_helper', universityId })
  helper2 = await db.createUser({ username: 'idea_helper_two', universityId })
  outsider = await db.createUser({ username: 'idea_outsider' })
  classmate = await db.createUser({ username: 'idea_classmate', universityId })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** Insert an idea as the given user. Returns its id. */
async function createIdea(
  userId: string,
  overrides: Partial<{ title: string; visibility: string; status: string }> = {},
) {
  const rows = await db.asUser<{ id: string }>(
    userId,
    `insert into public.ideas (title, description, category, visibility, status)
     values ($1, $2, 'web', $3, $4)
     returning id`,
    [
      overrides.title ?? 'A test idea',
      PITCH,
      overrides.visibility ?? 'public',
      overrides.status ?? 'open',
    ],
  )
  return rows[0]!.id
}

/** Insert a project as the given user. Returns its id. */
async function createProject(
  userId: string,
  overrides: Partial<{ visibility: string }> = {},
) {
  const rows = await db.asUser<{ id: string }>(
    userId,
    `insert into public.projects (title, description, category, visibility, is_seeking_members)
     values ('An idea-backed project', 'A description long enough to be meaningful.', 'web', $1, true)
     returning id`,
    [overrides.visibility ?? 'public'],
  )
  return rows[0]!.id
}

async function addMember(projectId: string, profileId: string, role = 'member') {
  await db.asService(
    `insert into public.project_members (project_id, profile_id, role) values ($1, $2, $3)`,
    [projectId, profileId, role],
  )
}

// ---------------------------------------------------------------------------
// Ownership: the database decides who wrote an idea
// ---------------------------------------------------------------------------

describe('idea ownership', () => {
  it('forces author_id to the caller, ignoring a forged value', async () => {
    const rows = await db.asUser<{ id: string }>(
      author,
      `insert into public.ideas (author_id, title, description, category)
       values ($1, 'A forged idea', $2, 'web') returning id`,
      [outsider, PITCH],
    )

    const idea = await db.asService<{ author_id: string }>(
      `select author_id from public.ideas where id = $1`,
      [rows[0]!.id],
    )
    expect(idea[0]!.author_id).toBe(author)
  })

  it('zeroes the counters whatever the client sends', async () => {
    // upvote_count, comment_count and interest_count are trigger-maintained. A client
    // that could seed them would make every number on the card a claim.
    const rows = await db.asUser<{ id: string }>(
      author,
      `insert into public.ideas
         (title, description, category, upvote_count, comment_count, interest_count)
       values ('Inflated idea', $1, 'web', 9999, 9999, 9999) returning id`,
      [PITCH],
    )

    const idea = await db.asService<{
      upvote_count: number
      comment_count: number
      interest_count: number
    }>(
      `select upvote_count, comment_count, interest_count from public.ideas where id = $1`,
      [rows[0]!.id],
    )
    expect(idea[0]!.upvote_count).toBe(0)
    expect(idea[0]!.comment_count).toBe(0)
    expect(idea[0]!.interest_count).toBe(0)
  })

  it('cannot be born converted or closed', async () => {
    const rows = await db.asUser<{ id: string; status: string }>(
      author,
      `insert into public.ideas (title, description, category, status)
       values ('Born closed', $1, 'web', 'closed') returning id, status`,
      [PITCH],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it("denormalises the author's university onto the idea", async () => {
    const ideaId = await createIdea(author)
    const rows = await db.asService<{ university_id: string | null }>(
      `select university_id from public.ideas where id = $1`,
      [ideaId],
    )
    expect(rows[0]!.university_id).toBe(universityId)
  })

  it('does not let an anonymous visitor write an idea', async () => {
    await expectRejection(
      () =>
        db.asAnon(
          `insert into public.ideas (title, description, category)
           values ('Anonymous idea', $1, 'web')`,
          [PITCH],
        ),
      REJECTS.permissionDenied,
    )
  })
})

// ---------------------------------------------------------------------------
// Editing and closing: the author's own, and nobody else's
// ---------------------------------------------------------------------------

describe('who may edit or close an idea', () => {
  it('lets the author edit their own idea', async () => {
    const ideaId = await createIdea(author)

    const rows = await db.asUser<{ title: string }>(
      author,
      `update public.ideas set title = 'A better title' where id = $1 returning title`,
      [ideaId],
    )
    expect(rows[0]!.title).toBe('A better title')
  })

  it('does not let an unrelated user edit it', async () => {
    const ideaId = await createIdea(author)

    // No error: ideas_update_own filters the row out, so the statement simply
    // touches nothing.
    await db.asUser(outsider, `update public.ideas set title = 'Hijacked' where id = $1`, [ideaId])

    const rows = await db.asService<{ title: string }>(
      `select title from public.ideas where id = $1`,
      [ideaId],
    )
    expect(rows[0]!.title).toBe('A test idea')
  })

  it('does not let an unrelated user edit it by naming the author as author_id', async () => {
    const ideaId = await createIdea(author)

    // Substituting the owner's id is the obvious escalation, and the column-level
    // UPDATE grant is what refuses it.
    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `update public.ideas set author_id = $1 where id = $2`,
          [outsider, ideaId],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let an unrelated user close it', async () => {
    const ideaId = await createIdea(author)

    await db.asUser(outsider, `update public.ideas set status = 'closed' where id = $1`, [ideaId])

    const rows = await db.asService<{ status: string }>(
      `select status from public.ideas where id = $1`,
      [ideaId],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('lets the author close it, and reopen it', async () => {
    const ideaId = await createIdea(author)

    await db.asUser(author, `update public.ideas set status = 'closed' where id = $1`, [ideaId])
    const closed = await db.asService<{ status: string }>(
      `select status from public.ideas where id = $1`,
      [ideaId],
    )
    expect(closed[0]!.status).toBe('closed')

    await db.asUser(author, `update public.ideas set status = 'open' where id = $1`, [ideaId])
    const reopened = await db.asService<{ status: string }>(
      `select status from public.ideas where id = $1`,
      [ideaId],
    )
    expect(reopened[0]!.status).toBe('open')
  })

  it('refuses a direct write to converted_project_id', async () => {
    // Conversion has to go through the function, which sets both columns together.
    const ideaId = await createIdea(author)
    const projectId = await createProject(author)

    await expectRejection(
      () =>
        db.asUser(
          author,
          `update public.ideas set converted_project_id = $1 where id = $2`,
          [projectId, ideaId],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a non-author adding a required skill to the idea', async () => {
    const ideaId = await createIdea(author)

    await expectRejection(
      () =>
        db.asUser(
          helper,
          `insert into public.idea_skills (idea_id, skill_id) values ($1, $2)`,
          [ideaId, skillId],
        ),
      REJECTS.rlsViolation,
    )
  })
})

// ---------------------------------------------------------------------------
// Interest: "I would help build this"
// ---------------------------------------------------------------------------

describe('offers to help', () => {
  it('lets a classmate offer to help', async () => {
    const ideaId = await createIdea(author)

    const rows = await db.asUser<{ profile_id: string }>(
      helper,
      `insert into public.idea_interest (idea_id, profile_id, message, offering)
       values ($1, $2, 'I can do the front end.', 'React') returning profile_id`,
      [ideaId, helper],
    )
    expect(rows[0]!.profile_id).toBe(helper)

    const count = await db.asService<{ interest_count: number }>(
      `select interest_count from public.ideas where id = $1`,
      [ideaId],
    )
    expect(count[0]!.interest_count).toBe(1)
  })

  it('cannot be written on someone else\u2019s behalf', async () => {
    // The trigger overwrites profile_id with auth.uid() before the WITH CHECK runs,
    // so a forged id cannot attach an offer to the person named in it.
    const ideaId = await createIdea(author)

    const rows = await db.asUser<{ profile_id: string }>(
      outsider,
      `insert into public.idea_interest (idea_id, profile_id, message)
       values ($1, $2, 'Offered on your behalf') returning profile_id`,
      [ideaId, helper],
    )
    expect(rows[0]!.profile_id).toBe(outsider)

    const forHelper = await db.asService<{ profile_id: string }>(
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(forHelper.map((row) => row.profile_id)).toEqual([outsider])
  })

  it('refuses the author offering to help with their own idea', async () => {
    const ideaId = await createIdea(author)

    await expectRejection(
      () =>
        db.asUser(
          author,
          `insert into public.idea_interest (idea_id, profile_id) values ($1, $2)`,
          [ideaId, author],
        ),
      /proposed this idea/i,
    )
  })

  it('allows one offer per person', async () => {
    const ideaId = await createIdea(author)

    await db.asUser(
      helper,
      `insert into public.idea_interest (idea_id, profile_id) values ($1, $2)`,
      [ideaId, helper],
    )

    await expectRejection(
      () =>
        db.asUser(
          helper,
          `insert into public.idea_interest (idea_id, profile_id) values ($1, $2)`,
          [ideaId, helper],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('keeps one offer between the offeror and the author', async () => {
    const ideaId = await createIdea(author)
    await db.asUser(
      helper,
      `insert into public.idea_interest (idea_id, profile_id, message)
       values ($1, $2, 'A private message')`,
      [ideaId, helper],
    )

    // The author reads every offer; the offeror reads their own; a third party reads
    // none of them. The count is public information, the pitch is not.
    const asAuthor = await db.asUser<{ profile_id: string }>(
      author,
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(asAuthor.map((row) => row.profile_id)).toEqual([helper])

    const asSelf = await db.asUser<{ profile_id: string }>(
      helper,
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(asSelf).toHaveLength(1)

    const asStranger = await db.asUser<{ profile_id: string }>(
      outsider,
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(asStranger).toEqual([])
  })

  it('lets an offer be taken back, but only one\u2019s own', async () => {
    const ideaId = await createIdea(author)
    await db.asUser(
      helper,
      `insert into public.idea_interest (idea_id, profile_id) values ($1, $2)`,
      [ideaId, helper],
    )

    // An unrelated user deleting by substituting the offeror's id removes nothing.
    await db.asUser(
      outsider,
      `delete from public.idea_interest where idea_id = $1 and profile_id = $2`,
      [ideaId, helper],
    )
    const still = await db.asService<{ profile_id: string }>(
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(still).toHaveLength(1)

    await db.asUser(
      helper,
      `delete from public.idea_interest where idea_id = $1 and profile_id = $2`,
      [ideaId, helper],
    )
    const gone = await db.asService<{ profile_id: string }>(
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(gone).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

describe('votes', () => {
  it('records one vote per person', async () => {
    const ideaId = await createIdea(author)

    await db.asUser(helper, `insert into public.idea_votes (idea_id, profile_id) values ($1, $2)`, [
      ideaId,
      helper,
    ])

    await expectRejection(
      () =>
        db.asUser(helper, `insert into public.idea_votes (idea_id, profile_id) values ($1, $2)`, [
          ideaId,
          helper,
        ]),
      REJECTS.uniqueViolation,
    )
  })

  it('records the vote for the caller, not for the id in the statement', async () => {
    const ideaId = await createIdea(author)

    const rows = await db.asUser<{ profile_id: string }>(
      outsider,
      `insert into public.idea_votes (idea_id, profile_id) values ($1, $2) returning profile_id`,
      [ideaId, helper],
    )
    expect(rows[0]!.profile_id).toBe(outsider)
  })

  it('maintains upvote_count from the rows', async () => {
    const ideaId = await createIdea(author)

    for (const voter of [helper, helper2, classmate]) {
      await db.asUser(voter, `insert into public.idea_votes (idea_id, profile_id) values ($1, $2)`, [
        ideaId,
        voter,
      ])
    }

    const rows = await db.asService<{ upvote_count: number }>(
      `select upvote_count from public.ideas where id = $1`,
      [ideaId],
    )
    expect(rows[0]!.upvote_count).toBe(3)

    await db.asUser(helper, `delete from public.idea_votes where idea_id = $1 and profile_id = $2`, [
      ideaId,
      helper,
    ])
    const after = await db.asService<{ upvote_count: number }>(
      `select upvote_count from public.ideas where id = $1`,
      [ideaId],
    )
    expect(after[0]!.upvote_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Moderation: a hidden idea is the author's business alone
// ---------------------------------------------------------------------------

describe('a hidden idea', () => {
  it('is invisible to everyone but its author', async () => {
    const ideaId = await createIdea(author)

    await db.asService(`update public.ideas set moderation_status = 'hidden' where id = $1`, [
      ideaId,
    ])

    const asStranger = await db.asUser<{ id: string }>(
      outsider,
      `select id from public.ideas where id = $1`,
      [ideaId],
    )
    expect(asStranger).toEqual([])

    const asAnon = await db.asAnon<{ id: string }>(
      `select id from public.ideas where id = $1`,
      [ideaId],
    )
    expect(asAnon).toEqual([])

    // The author keeps it in their own list: a moderated idea that silently vanished
    // would be worse than one flagged.
    const asAuthor = await db.asUser<{ id: string }>(
      author,
      `select id from public.ideas where id = $1`,
      [ideaId],
    )
    expect(asAuthor).toHaveLength(1)
  })

  it('still lets the author read the offers on it', async () => {
    const ideaId = await createIdea(author)
    await db.asUser(
      helper,
      `insert into public.idea_interest (idea_id, profile_id, message) values ($1, $2, 'Still here')`,
      [ideaId, helper],
    )

    await db.asService(`update public.ideas set moderation_status = 'hidden' where id = $1`, [
      ideaId,
    ])

    const asAuthor = await db.asUser<{ profile_id: string }>(
      author,
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(asAuthor).toHaveLength(1)

    const asStranger = await db.asUser<{ profile_id: string }>(
      outsider,
      `select profile_id from public.idea_interest where idea_id = $1`,
      [ideaId],
    )
    expect(asStranger).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Project updates: the post stream anchored to a project
// ---------------------------------------------------------------------------

describe('project updates', () => {
  it('lets a member post an update, and counts it on the project', async () => {
    const projectId = await createProject(author)
    const member = await db.createUser({ username: 'update_member', universityId })
    await addMember(projectId, member)

    const rows = await db.asUser<{ id: string }>(
      member,
      `insert into public.posts (type, body, project_id, visibility)
       values ('project_update', 'The first update.', $1, 'university') returning id`,
      [projectId],
    )
    expect(rows).toHaveLength(1)

    // post_count is trigger-maintained from the rows, not a number we computed.
    const project = await db.asService<{ post_count: number }>(
      `select post_count from public.projects where id = $1`,
      [projectId],
    )
    expect(project[0]!.post_count).toBe(1)
  })

  it('refuses an update from someone who is not a member', async () => {
    const projectId = await createProject(author)

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.posts (type, body, project_id, visibility)
           values ('project_update', 'A hijack attempt.', $1, 'public')`,
          [projectId],
        ),
      /not a member/i,
    )
  })

  it('does not show a private project\u2019s updates to a non-member', async () => {
    const projectId = await createProject(author, { visibility: 'private' })

    await db.asUser(
      author,
      `insert into public.posts (type, body, project_id, visibility)
       values ('project_update', 'Internal note.', $1, 'private')`,
      [projectId],
    )

    const asMember = await db.asUser<{ id: string }>(
      author,
      `select id from public.posts where project_id = $1`,
      [projectId],
    )
    expect(asMember).toHaveLength(1)

    const asStranger = await db.asUser<{ id: string }>(
      outsider,
      `select id from public.posts where project_id = $1`,
      [projectId],
    )
    expect(asStranger).toEqual([])

    const asAnon = await db.asAnon<{ id: string }>(
      `select id from public.posts where project_id = $1`,
      [projectId],
    )
    expect(asAnon).toEqual([])
  })

  it('shows a shared update to a classmate and not to a stranger', async () => {
    // The cross-post path: the update is a real post, so it appears in the feed under
    // the same visibility rules as any other post.
    const projectId = await createProject(author)

    await db.asUser(
      author,
      `insert into public.posts (type, body, project_id, visibility)
       values ('project_update', 'Shipped the first screen.', $1, 'university')`,
      [projectId],
    )

    const asClassmate = await db.asUser<{ id: string }>(
      classmate,
      `select id from public.posts where project_id = $1`,
      [projectId],
    )
    expect(asClassmate).toHaveLength(1)

    const asStranger = await db.asUser<{ id: string }>(
      outsider,
      `select id from public.posts where project_id = $1`,
      [projectId],
    )
    expect(asStranger).toEqual([])
  })

  it('does not let a non-member anchor a post to the project', async () => {
    const projectId = await createProject(author)

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.posts (type, body, project_id, visibility)
           values ('text', 'About a project I am not on.', $1, 'public')`,
          [projectId],
        ),
      /not a member/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Conversion: the idea becomes a project, once
// ---------------------------------------------------------------------------

describe('idea to project conversion', () => {
  it('creates the project, carries the skills, and marks the idea converted', async () => {
    const ideaId = await createIdea(author)
    await db.asUser(
      author,
      `insert into public.idea_skills (idea_id, skill_id) values ($1, $2)`,
      [ideaId, skillId],
    )

    const rows = await db.asUser<{ convert_idea_to_project: string }>(
      author,
      `select public.convert_idea_to_project($1) as convert_idea_to_project`,
      [ideaId],
    )
    const projectId = rows[0]!.convert_idea_to_project
    expect(projectId).toBeTruthy()

    const idea = await db.asService<{
      status: string
      converted_project_id: string | null
      converted_at: string | null
    }>(
      `select status, converted_project_id, converted_at from public.ideas where id = $1`,
      [ideaId],
    )
    expect(idea[0]!.status).toBe('converted')
    expect(idea[0]!.converted_project_id).toBe(projectId)
    expect(idea[0]!.converted_at).not.toBeNull()

    // The machine-readable half of the ask is not lost on the way across.
    const skills = await db.asService<{ skill_id: string; is_required: boolean }>(
      `select skill_id, is_required from public.project_skills where project_id = $1`,
      [projectId],
    )
    expect(skills).toHaveLength(1)
    expect(skills[0]!.skill_id).toBe(skillId)
    expect(skills[0]!.is_required).toBe(true)

    // The author owns it, through a real membership row.
    const project = await db.asService<{ owner_id: string; member_count: number; status: string }>(
      `select owner_id, member_count, status from public.projects where id = $1`,
      [projectId],
    )
    expect(project[0]!.owner_id).toBe(author)
    expect(project[0]!.member_count).toBe(1)
    expect(project[0]!.status).toBe('planning')
  })

  it('carries the interested people across as invitations', async () => {
    // The function creates the project; the invites are what the wizard promises. Both
    // halves are checked here: the offers survived the conversion, and the new owner can
    // turn each of them into a real invite row.
    const ideaId = await createIdea(author)
    await db.asUser(
      helper,
      `insert into public.idea_interest (idea_id, profile_id, offering) values ($1, $2, 'Design')`,
      [ideaId, helper],
    )
    await db.asUser(
      helper2,
      `insert into public.idea_interest (idea_id, profile_id, offering) values ($1, $2, 'Data')`,
      [ideaId, helper2],
    )

    const rows = await db.asUser<{ convert_idea_to_project: string }>(
      author,
      `select public.convert_idea_to_project($1) as convert_idea_to_project`,
      [ideaId],
    )
    const projectId = rows[0]!.convert_idea_to_project

    // The author still reads both offers after conversion: the invite loop in the
    // action reads exactly this.
    const interested = await db.asUser<{ profile_id: string }>(
      author,
      `select profile_id from public.idea_interest where idea_id = $1 order by created_at`,
      [ideaId],
    )
    expect(interested).toHaveLength(2)

    for (const person of interested) {
      await db.asUser(
        author,
        `insert into public.project_invites (project_id, invitee_id, message)
         values ($1, $2, 'You said you would help build this.')`,
        [projectId, person.profile_id],
      )
    }

    const invites = await db.asService<{ invitee_id: string; status: string; inviter_id: string }>(
      `select invitee_id, status, inviter_id from public.project_invites where project_id = $1`,
      [projectId],
    )
    expect(invites).toHaveLength(2)
    expect(invites.every((row) => row.status === 'pending')).toBe(true)
    expect(invites.every((row) => row.inviter_id === author)).toBe(true)
  })

  it('refuses a second conversion of the same idea', async () => {
    const ideaId = await createIdea(author)
    await db.asUser(author, `select public.convert_idea_to_project($1)`, [ideaId])

    await expectRejection(
      () => db.asUser(author, `select public.convert_idea_to_project($1)`, [ideaId]),
      /already become a project/i,
    )
  })

  it('refuses conversion by anyone but the author', async () => {
    const ideaId = await createIdea(author)

    await expectRejection(
      () => db.asUser(outsider, `select public.convert_idea_to_project($1)`, [ideaId]),
      REJECTS.notPermitted,
    )
  })

  it('refuses an anonymous visitor the conversion at all', async () => {
    const ideaId = await createIdea(author)

    await expectRejection(
      () => db.asAnon(`select public.convert_idea_to_project($1)`, [ideaId]),
      REJECTS.permissionDenied,
    )
  })

  it('refuses a conversion of an idea that does not exist', async () => {
    await expectRejection(
      () =>
        db.asUser(author, `select public.convert_idea_to_project($1)`, [
          '00000000-0000-0000-0000-000000000000',
        ]),
      /not found|P0002/i,
    )
  })
})
