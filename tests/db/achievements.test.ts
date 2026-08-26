/**
 * Achievements: awarding, non-forgeability, and visibility.
 *
 * The whole value of a badge is that its holder could not have given it to
 * themselves. So most of this file is not about achievements being awarded --
 * it is about the ways a client might try to manufacture one:
 *
 *   - inserting a row into profile_achievements directly
 *   - editing awarded_at / awarded_value / achievement_key on a real award
 *   - deleting an award they would rather not have
 *   - calling app.award_achievement() over RPC
 *   - publishing an "achievement" post naming a badge they do not hold
 *
 * Every one of those has to fail at the database, not in the UI, because the UI
 * is a suggestion. Spec §33 and §60: the platform must not present a claim it
 * cannot substantiate.
 *
 * The awarding tests are written against the *underlying facts* -- insert real
 * posts, accept real connections, write real daily logs -- rather than by poking
 * the counters. A test that sets post_count = 50 by hand proves the threshold
 * arithmetic and nothing about whether posting actually reaches it.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb

let uniId: string
let student: string
let peer: string
let outsider: string
let admin: string

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (name, slug, country, status)
     values ('Achievement University', 'ach-uni', 'DE', 'approved')
     returning id`,
  )
  uniId = uni[0]!.id

  student = await db.createUser({ username: 'ach_student', universityId: uniId })
  peer = await db.createUser({ username: 'ach_peer', universityId: uniId })
  outsider = await db.createUser({ username: 'ach_outsider' })
  admin = await db.createUser({ username: 'ach_admin', role: 'admin' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** Awards held by a profile, read with full privileges. */
async function awards(profile: string) {
  const rows = await db.asService<{ achievement_key: string; awarded_value: number | null }>(
    `select achievement_key, awarded_value
       from public.profile_achievements
      where profile_id = $1
      order by achievement_key`,
    [profile],
  )
  return rows
}

async function keys(profile: string) {
  return (await awards(profile)).map((r) => r.achievement_key)
}

/** A fresh user with nothing awarded, so threshold tests start from zero. */
async function freshUser(username: string, universityId = uniId) {
  return db.createUser({ username, universityId })
}

// =============================================================================

describe('the catalogue', () => {
  it('is readable by an anonymous visitor', async () => {
    // A badge on a public profile is meaningless if the reader cannot look up
    // what was counted.
    const rows = await db.asAnon<{ key: string; criteria: string }>(
      `select key, criteria from public.achievement_definitions order by sort_order`,
    )
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.every((r) => r.criteria.trim().length > 0)).toBe(true)
  })

  it('never words a definition as an assessment of the holder', async () => {
    // The one invariant that matters about this catalogue's wording. A row saying
    // "counted 50 posts" is a fact; "Expert Writer" is a claim the platform
    // cannot substantiate, and spec §33/§60 forbid making it. Checked over name,
    // description and criteria together so a definition added later cannot
    // smuggle the claim into whichever field the UI happens to render.
    const rows = await db.asService<{ key: string; offending: string }>(
      `select key, name || ' | ' || description || ' | ' || criteria as offending
         from public.achievement_definitions
        where (name || ' ' || description || ' ' || criteria) ~*
              '\\y(expert|master|guru|genius|best|top|elite|verified|certified|proven|skilled|talented|qualified)\\y'
        order by key`,
    )
    expect(rows.map((r) => `${r.key}: ${r.offending}`)).toEqual([])
  })

  it('describes something concrete for every definition', async () => {
    const rows = await db.asService<{ key: string }>(
      `select key from public.achievement_definitions
        where length(btrim(criteria)) < 12`,
    )
    expect(rows.map((r) => r.key)).toEqual([])
  })

  it('cannot be edited by an ordinary user', async () => {
    // The UPDATE is a silent no-op, not an error: RLS filters rows out of the
    // USING clause, and an UPDATE that matches nothing is a legal statement.
    // So the assertion has to read the row back rather than expect a throw.
    await db.asUser(
      student,
      `update public.achievement_definitions set name = 'Gold Star' where key = 'first_post'`,
    )
    const after = await db.asService<{ name: string }>(
      `select name from public.achievement_definitions where key = 'first_post'`,
    )
    expect(after[0]!.name).toBe('First Post')

    // INSERT has no USING clause to filter, so WITH CHECK rejects it outright.
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.achievement_definitions
             (key, name, description, criteria, category, icon)
           values ('best_student', 'Best Student', 'x', 'nothing', 'community', 'star')`,
        ),
      REJECTS.rlsViolation,
    )

    await db.asUser(
      student,
      `delete from public.achievement_definitions where key = 'first_post'`,
    )
    const stillThere = await db.asService<{ count: number }>(
      `select count(*)::int as count from public.achievement_definitions
        where key = 'first_post'`,
    )
    expect(stillThere[0]!.count).toBe(1)
  })

  it('can be edited by an admin', async () => {
    await db.asUser(
      admin,
      `update public.achievement_definitions set sort_order = 99 where key = 'first_post'`,
    )
    const rows = await db.asService<{ sort_order: number }>(
      `select sort_order from public.achievement_definitions where key = 'first_post'`,
    )
    expect(rows[0]!.sort_order).toBe(99)

    await db.asService(
      `update public.achievement_definitions set sort_order = 10 where key = 'first_post'`,
    )
  })
})

// =============================================================================

describe('awarding from real activity', () => {
  it('awards first_post when the user actually posts', async () => {
    const user = await freshUser('ach_poster1')
    expect(await keys(user)).toEqual([])

    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'hello')`, [
      user,
    ])

    const held = await awards(user)
    expect(held.map((r) => r.achievement_key)).toEqual(['first_post'])
    expect(held[0]!.awarded_value).toBe(1)
  })

  it('awards posts_10 at ten posts and not before', async () => {
    const user = await freshUser('ach_poster2')

    for (let i = 0; i < 9; i += 1) {
      await db.asUser(user, `insert into public.posts (author_id, body) values ($1, $2)`, [
        user,
        `post ${i}`,
      ])
    }
    expect(await keys(user)).toEqual(['first_post'])

    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'tenth')`, [
      user,
    ])

    const held = await awards(user)
    expect(held.map((r) => r.achievement_key).sort()).toEqual(['first_post', 'posts_10'])
    expect(held.find((r) => r.achievement_key === 'posts_10')!.awarded_value).toBe(10)
    // Fifty is a different badge and has not been reached.
    expect(await keys(user)).not.toContain('posts_50')
  })

  it('does not duplicate or re-stamp an award already held', async () => {
    const user = await freshUser('ach_poster3')

    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'one')`, [user])
    const first = await db.asService<{ awarded_at: string }>(
      `select awarded_at from public.profile_achievements
        where profile_id = $1 and achievement_key = 'first_post'`,
      [user],
    )

    for (let i = 0; i < 4; i += 1) {
      await db.asUser(user, `insert into public.posts (author_id, body) values ($1, $2)`, [
        user,
        `more ${i}`,
      ])
    }

    const after = await db.asService<{ awarded_at: string; count: number }>(
      `select awarded_at, count(*) over ()::int as count
         from public.profile_achievements
        where profile_id = $1 and achievement_key = 'first_post'`,
      [user],
    )
    expect(after).toHaveLength(1)
    // The award records when the threshold was crossed. Crossing it again is not
    // an event.
    expect(after[0]!.awarded_at).toEqual(first[0]!.awarded_at)
  })

  it('awards first_project when the user creates a project', async () => {
    const user = await freshUser('ach_builder1')

    await db.asUser(
      user,
      `insert into public.projects (owner_id, title, slug) values ($1, 'Thesis Tool', 'thesis-tool-1')`,
      [user],
    )

    // 'team_member' must NOT be here: the owner's own membership row is role
    // 'owner', and joining a project you started is not joining someone else's.
    expect(await keys(user)).toEqual(['first_project'])
  })

  it('awards team_member for joining a project someone else owns', async () => {
    const owner = await freshUser('ach_owner2')
    const joiner = await freshUser('ach_joiner2')

    const project = await db.asUser<{ id: string }>(
      owner,
      `insert into public.projects (owner_id, title, slug)
       values ($1, 'Shared Build', 'shared-build-2') returning id`,
      [owner],
    )

    await db.asUser(
      owner,
      `insert into public.project_members (project_id, profile_id, role)
       values ($1, $2, 'member')`,
      [project[0]!.id, joiner],
    )

    expect(await keys(joiner)).toContain('team_member')
    expect(await keys(owner)).not.toContain('team_member')
  })

  it('awards first_idea and idea_converted from the real conversion path', async () => {
    const user = await freshUser('ach_ideator')

    const idea = await db.asUser<{ id: string }>(
      user,
      `insert into public.ideas (author_id, title, description)
       values ($1, 'Course swap board', 'Let students trade seats') returning id`,
      [user],
    )
    expect(await keys(user)).toEqual(['first_idea'])

    // Conversion goes through the RPC: `converted_project_id` is deliberately
    // absent from the client UPDATE grant on ideas, so there is no way to claim a
    // conversion without one actually happening.
    await db.asUser(user, `select public.convert_idea_to_project($1)`, [idea[0]!.id])

    expect(await keys(user)).toEqual(
      ['first_idea', 'first_project', 'idea_converted'].sort(),
    )
  })

  it('awards first_connection only once the request is accepted', async () => {
    const a = await freshUser('ach_conn_a')
    const b = await freshUser('ach_conn_b')

    const conn = await db.asUser<{ id: string }>(
      a,
      `insert into public.connections (requester_id, addressee_id) values ($1, $2) returning id`,
      [a, b],
    )
    // A pending request is not a connection.
    expect(await keys(a)).toEqual([])
    expect(await keys(b)).toEqual([])

    await db.asUser(b, `update public.connections set status = 'accepted' where id = $1`, [
      conn[0]!.id,
    ])

    expect(await keys(a)).toEqual(['first_connection'])
    expect(await keys(b)).toEqual(['first_connection'])
  })

  it('awards endorsed_5 at the fifth endorsement of one skill', async () => {
    const user = await freshUser('ach_endorsed')

    const skill = await db.asService<{ id: string }>(
      `insert into public.skills (name, slug, is_approved) values ('Rust', 'rust', true)
       returning id`,
    )
    await db.asUser(
      user,
      `insert into public.profile_skills (profile_id, skill_id, level) values ($1, $2, 'familiar')`,
      [user, skill[0]!.id],
    )

    for (let i = 0; i < 4; i += 1) {
      const endorser = await freshUser(`ach_endorser_${i}`)
      await db.asUser(
        endorser,
        `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
         values ($1, $2, $3)`,
        [user, skill[0]!.id, endorser],
      )
    }
    expect(await keys(user)).not.toContain('endorsed_5')

    const fifth = await freshUser('ach_endorser_5')
    await db.asUser(
      fifth,
      `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
       values ($1, $2, $3)`,
      [user, skill[0]!.id, fifth],
    )

    const held = await awards(user)
    expect(held.map((r) => r.achievement_key)).toContain('endorsed_5')
    expect(held.find((r) => r.achievement_key === 'endorsed_5')!.awarded_value).toBe(5)
  })

  it('awards goal achievements and counts completions', async () => {
    const user = await freshUser('ach_goals')

    const goal = await db.asUser<{ id: string }>(
      user,
      `insert into public.goals (profile_id, title, category) values ($1, 'Learn Rust', 'skill')
       returning id`,
      [user],
    )
    expect(await keys(user)).toEqual(['first_goal'])

    await db.asUser(user, `update public.goals set status = 'completed' where id = $1`, [
      goal[0]!.id,
    ])

    const held = await awards(user)
    expect(held.map((r) => r.achievement_key).sort()).toEqual(['first_goal', 'goal_completed'])
    expect(held.find((r) => r.achievement_key === 'goal_completed')!.awarded_value).toBe(1)
    // Ten is a separate badge; one completion is not ten.
    expect(await keys(user)).not.toContain('goals_completed_10')
  })

  it('does not re-award goal_completed when a goal is reopened and finished again', async () => {
    const user = await freshUser('ach_goal_toggle')
    const goal = await db.asUser<{ id: string }>(
      user,
      `insert into public.goals (profile_id, title) values ($1, 'Toggle me') returning id`,
      [user],
    )

    await db.asUser(user, `update public.goals set status = 'completed' where id = $1`, [
      goal[0]!.id,
    ])
    await db.asUser(user, `update public.goals set status = 'active' where id = $1`, [
      goal[0]!.id,
    ])
    await db.asUser(user, `update public.goals set status = 'completed' where id = $1`, [
      goal[0]!.id,
    ])

    const rows = await db.asService<{ count: number }>(
      `select count(*)::int as count from public.profile_achievements
        where profile_id = $1 and achievement_key = 'goal_completed'`,
      [user],
    )
    expect(rows[0]!.count).toBe(1)
  })

  it('awards streak_7 for seven consecutive daily logs and not for a gap', async () => {
    const broken = await freshUser('ach_streak_broken')
    // Seven logs, but day 3 is missing. Seven rows is not a seven day streak.
    for (const offset of [0, 1, 2, 4, 5, 6, 7]) {
      await db.asUser(
        broken,
        `insert into public.daily_logs (profile_id, log_date, mood)
         values ($1, current_date - $2::integer, 3)`,
        [broken, offset],
      )
    }
    expect(await keys(broken)).not.toContain('streak_7')

    const unbroken = await freshUser('ach_streak_ok')
    // Inserted oldest-first, because the award fires on the row that completes
    // the run and the trigger only looks backwards from the row being written.
    for (const offset of [6, 5, 4, 3, 2, 1, 0]) {
      await db.asUser(
        unbroken,
        `insert into public.daily_logs (profile_id, log_date, mood)
         values ($1, current_date - $2::integer, 4)`,
        [unbroken, offset],
      )
    }

    const held = await awards(unbroken)
    expect(held.map((r) => r.achievement_key)).toContain('streak_7')
    expect(held.find((r) => r.achievement_key === 'streak_7')!.awarded_value).toBe(7)
    expect(held.map((r) => r.achievement_key)).not.toContain('streak_30')
  })

  it('awards profile_complete only when every rendered field is filled', async () => {
    const user = await freshUser('ach_profile')

    await db.asUser(
      user,
      `update public.profiles set headline = 'CS student', bio = 'I build things'
        where id = $1`,
      [user],
    )
    // No avatar and onboarding unfinished: the profile page would still render
    // placeholders, so the badge would be a lie.
    expect(await keys(user)).not.toContain('profile_complete')

    await db.asUser(
      user,
      `update public.profiles
          set avatar_url = 'https://example.test/a.png', onboarding_completed = true
        where id = $1`,
      [user],
    )

    expect(await keys(user)).toContain('profile_complete')
  })
})

// =============================================================================

describe('awards cannot be forged', () => {
  it('does not let a user insert an award for themselves', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.profile_achievements (profile_id, achievement_key)
           values ($1, 'posts_50')`,
          [student],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a user insert an award for anybody else', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.profile_achievements (profile_id, achievement_key)
           values ($1, 'first_post')`,
          [peer],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('does not let a user delete an award', async () => {
    const user = await freshUser('ach_deleter')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])
    expect(await keys(user)).toEqual(['first_post'])

    await expectRejection(
      () =>
        db.asUser(user, `delete from public.profile_achievements where profile_id = $1`, [user]),
      REJECTS.permissionDenied,
    )

    expect(await keys(user)).toEqual(['first_post'])
  })

  it('does not let a user rewrite which achievement an award is for', async () => {
    const user = await freshUser('ach_swapper')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])

    await expectRejection(
      () =>
        db.asUser(
          user,
          `update public.profile_achievements set achievement_key = 'posts_50'
            where profile_id = $1`,
          [user],
        ),
      /permission denied|cannot be modified/i,
    )
  })

  it('does not let a user backdate an award or inflate its value', async () => {
    const user = await freshUser('ach_backdater')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])

    await expectRejection(
      () =>
        db.asUser(
          user,
          `update public.profile_achievements set awarded_at = now() - interval '2 years'
            where profile_id = $1`,
          [user],
        ),
      /permission denied|cannot be modified/i,
    )

    await expectRejection(
      () =>
        db.asUser(
          user,
          `update public.profile_achievements set awarded_value = 9999 where profile_id = $1`,
          [user],
        ),
      /permission denied|cannot be modified/i,
    )
  })

  it('does not let a user call the awarding function over RPC', async () => {
    // app.award_achievement is granted to no client role at all. PostgREST does
    // not serve the `app` schema either, so this is the second of two locks.
    await expectRejection(
      () => db.asUser(student, `select app.award_achievement($1, 'posts_50')`, [student]),
      REJECTS.permissionDenied,
    )
  })

  it('lets a user pin and unpin their own award', async () => {
    const user = await freshUser('ach_pinner')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])

    await db.asUser(
      user,
      `update public.profile_achievements set is_pinned = true where profile_id = $1`,
      [user],
    )
    const rows = await db.asService<{ is_pinned: boolean }>(
      `select is_pinned from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(rows[0]!.is_pinned).toBe(true)
  })

  it('does not let a user pin somebody else’s award', async () => {
    const owner = await freshUser('ach_pin_owner')
    await db.asUser(owner, `insert into public.posts (author_id, body) values ($1, 'x')`, [owner])

    // The UPDATE matches no row under the policy, so it is a silent no-op rather
    // than an error -- which is why the assertion reads the row back.
    await db.asUser(
      peer,
      `update public.profile_achievements set is_pinned = true where profile_id = $1`,
      [owner],
    )

    const rows = await db.asService<{ is_pinned: boolean }>(
      `select is_pinned from public.profile_achievements where profile_id = $1`,
      [owner],
    )
    expect(rows[0]!.is_pinned).toBe(false)
  })

  it('refuses an award for a key that does not exist', async () => {
    // Belt and braces on top of award_achievement's own definition check: even a
    // future privileged path cannot invent a badge with no published criteria.
    await expectRejection(
      () =>
        db.asService(
          `insert into public.profile_achievements (profile_id, achievement_key)
           values ($1, 'employee_of_the_month')`,
          [student],
        ),
      REJECTS.foreignKey,
    )
  })
})

// =============================================================================

describe('who can see an award', () => {
  it('shows an anonymous visitor awards on a public profile', async () => {
    const user = await freshUser('ach_public')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])

    const rows = await db.asAnon<{ achievement_key: string }>(
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(rows.map((r) => r.achievement_key)).toEqual(['first_post'])
  })

  it('hides awards on a private profile from everyone but the holder', async () => {
    const user = await freshUser('ach_private')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])
    await db.asService(`update public.profiles set visibility = 'private' where id = $1`, [user])

    const asPeer = await db.asUser<{ achievement_key: string }>(
      peer,
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(asPeer).toEqual([])

    const asVisitor = await db.asAnon<{ achievement_key: string }>(
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(asVisitor).toEqual([])

    // The holder still sees their own.
    const asSelf = await db.asUser<{ achievement_key: string }>(
      user,
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(asSelf.map((r) => r.achievement_key)).toEqual(['first_post'])
  })

  it('hides awards on a university-scoped profile from an outsider', async () => {
    const user = await freshUser('ach_uni_scoped')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'x')`, [user])
    await db.asService(`update public.profiles set visibility = 'university' where id = $1`, [
      user,
    ])

    const samePlace = await db.asUser(
      peer,
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(samePlace).toHaveLength(1)

    const elsewhere = await db.asUser(
      outsider,
      `select achievement_key from public.profile_achievements where profile_id = $1`,
      [user],
    )
    expect(elsewhere).toEqual([])
  })
})

// =============================================================================

describe('posts anchored to an achievement', () => {
  it('accepts a post about an achievement the author holds', async () => {
    const user = await freshUser('ach_post_ok')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'first!')`, [
      user,
    ])

    const rows = await db.asUser<{ achievement_key: string }>(
      user,
      `insert into public.posts (author_id, type, body, achievement_key)
       values ($1, 'achievement', 'Got my first post badge', 'first_post')
       returning achievement_key`,
      [user],
    )
    expect(rows[0]!.achievement_key).toBe('first_post')
  })

  it('refuses a post about an achievement the author does not hold', async () => {
    const user = await freshUser('ach_post_liar')

    await expectRejection(
      () =>
        db.asUser(
          user,
          `insert into public.posts (author_id, type, body, achievement_key)
           values ($1, 'achievement', 'Fifty posts, honestly', 'posts_50')`,
          [user],
        ),
      /not been awarded that achievement/i,
    )
  })

  it('refuses an achievement key that is not in the catalogue', async () => {
    // The ownership trigger fires before the foreign key is checked, so the
    // message is "not awarded" rather than a constraint violation. Both are
    // correct answers to "may I publish this"; the FK is the backstop for
    // privileged paths that skip the trigger.
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.posts (author_id, type, body, achievement_key)
           values ($1, 'achievement', 'Employee of the month', 'employee_of_the_month')`,
          [student],
        ),
      /not been awarded that achievement/i,
    )

    await expectRejection(
      () =>
        db.asService(
          `insert into public.posts (author_id, type, body, achievement_key)
           values ($1, 'achievement', 'Employee of the month', 'employee_of_the_month')`,
          [student],
        ),
      REJECTS.foreignKey,
    )
  })

  it('does not let a client change a post’s achievement anchor at all', async () => {
    const user = await freshUser('ach_post_editor')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'one')`, [user])

    const post = await db.asUser<{ id: string }>(
      user,
      `insert into public.posts (author_id, type, body, achievement_key)
       values ($1, 'achievement', 'Badge!', 'first_post') returning id`,
      [user],
    )

    // achievement_key is absent from the column-level UPDATE grant on posts, so
    // the swap fails before the ownership trigger is reached. That is the stronger
    // guarantee -- an anchor is fixed at publication. The trigger still matters
    // for the INSERT path and for privileged server-side writes.
    await expectRejection(
      () =>
        db.asUser(
          user,
          `update public.posts set achievement_key = 'posts_50' where id = $1`,
          [post[0]!.id],
        ),
      REJECTS.permissionDenied,
    )

    const rows = await db.asService<{ achievement_key: string }>(
      `select achievement_key from public.posts where id = $1`,
      [post[0]!.id],
    )
    expect(rows[0]!.achievement_key).toBe('first_post')
  })

  it('nulls the anchor rather than deleting the post if a definition is retired', async () => {
    const user = await freshUser('ach_post_retire')
    await db.asUser(user, `insert into public.posts (author_id, body) values ($1, 'one')`, [user])

    const post = await db.asUser<{ id: string }>(
      user,
      `insert into public.posts (author_id, type, body, achievement_key)
       values ($1, 'achievement', 'Badge!', 'first_post') returning id`,
      [user],
    )

    await db.asService(`delete from public.achievement_definitions where key = 'first_post'`)

    const rows = await db.asService<{ achievement_key: string | null; body: string }>(
      `select achievement_key, body from public.posts where id = $1`,
      [post[0]!.id],
    )
    // on delete set null: the user's own writing survives an admin's catalogue
    // change. This test runs last in the file because it removes a definition.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.achievement_key).toBeNull()
  })
})
