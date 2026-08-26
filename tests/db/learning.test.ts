/**
 * Learning trackers: semesters, courses, goals, milestones, sessions, daily logs.
 *
 * The threat model here is different from the rest of the schema. Nothing in this
 * domain is interesting to steal *at scale* -- there is no follower graph to
 * scrape and no message thread to hijack. What there is instead is a small
 * amount of unusually damaging information about one person at a time: a grade,
 * a mood score, a record of exactly when they were at their desk.
 *
 * So the tests below are mostly the same test asked six ways: given a valid
 * session and the real row id, can user B read, write, or infer anything about
 * user A's private study data? And the second question, which the visibility
 * clamp exists to answer: can a shared goal or a public post end up displaying
 * something the owner marked private?
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let uniA: string
let student: string
let peer: string // same university as `student`
let outsider: string // no university

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('learn-uni', 'Learning University', 'approved') returning id`,
  )
  uniA = uni[0]!.id

  student = await db.createUser({ username: 'learner', universityId: uniA })
  peer = await db.createUser({ username: 'classmate', universityId: uniA })
  outsider = await db.createUser({ username: 'stranger' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function newSemester(owner: string, name = 'Autumn 2026', current = false) {
  const rows = await db.asUser<{ id: string }>(
    owner,
    `insert into public.semesters (profile_id, name, term, year, is_current)
     values ($1, $2, 'fall', 2026, $3) returning id`,
    [owner, name, current],
  )
  return rows[0]!.id
}

async function newCourse(owner: string, code = 'CS201', semesterId: string | null = null) {
  const rows = await db.asUser<{ id: string }>(
    owner,
    `insert into public.courses (profile_id, semester_id, code, title)
     values ($1, $2, $3, 'Algorithms') returning id`,
    [owner, semesterId, code],
  )
  return rows[0]!.id
}

async function newGoal(
  owner: string,
  visibility: 'public' | 'university' | 'connections' | 'private' = 'private',
  title = 'Read 12 papers',
) {
  const rows = await db.asUser<{ id: string }>(
    owner,
    `insert into public.goals (profile_id, title, visibility, target_value, unit)
     values ($1, $2, $3, 12, 'papers') returning id`,
    [owner, title, visibility],
  )
  return rows[0]!.id
}

// ===========================================================================
describe('semesters', () => {
  it('forces profile_id to the caller, ignoring a forged value', async () => {
    const rows = await db.asUser<{ id: string; profile_id: string }>(
      student,
      `insert into public.semesters (profile_id, name) values ($1, 'Forged')
       returning id, profile_id`,
      [peer],
    )
    expect(rows[0]!.profile_id).toBe(student)

    await db.asUser(student, `delete from public.semesters where id = $1`, [rows[0]!.id])
  })

  it('keeps at most one current semester per profile', async () => {
    const first = await newSemester(student, 'Spring 2026', true)
    const second = await newSemester(student, 'Autumn 2026', true)

    const rows = await db.asUser<{ id: string }>(
      student,
      `select id from public.semesters where profile_id = $1 and is_current`,
      [student],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(second)

    await db.asUser(student, `delete from public.semesters where id = any($1::uuid[])`, [
      [first, second],
    ])
  })

  it('does not let one profile\'s current semester displace another\'s', async () => {
    // The trigger's clearing UPDATE is scoped by profile_id. If it were not,
    // one student saving their term would quietly unset everyone else's.
    const mine = await newSemester(student, 'Mine', true)
    const theirs = await newSemester(peer, 'Theirs', true)

    const rows = await db.asUser<{ is_current: boolean }>(
      peer,
      `select is_current from public.semesters where id = $1`,
      [theirs],
    )
    expect(rows[0]!.is_current).toBe(true)

    await db.asUser(student, `delete from public.semesters where id = $1`, [mine])
    await db.asUser(peer, `delete from public.semesters where id = $1`, [theirs])
  })

  it('refuses an end date before the start date', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.semesters (profile_id, name, start_date, end_date)
           values ($1, 'Backwards', '2026-09-01', '2026-08-01')`,
          [student],
        ),
      REJECTS.checkViolation,
    )
  })

  it('hides one student\'s semesters from another', async () => {
    const mine = await newSemester(student, 'Hidden Term')

    const seen = await db.asUser<{ id: string }>(
      peer,
      `select id from public.semesters where id = $1`,
      [mine],
    )
    expect(seen).toHaveLength(0)

    await db.asUser(student, `delete from public.semesters where id = $1`, [mine])
  })

  it('is unreadable by an anonymous visitor', async () => {
    // No SELECT grant to anon at all -- the strongest form of "not public".
    await expectRejection(
      () => db.asAnon(`select id from public.semesters`),
      REJECTS.permissionDenied,
    )
  })
})

// ===========================================================================
describe('courses', () => {
  it('forces profile_id to the caller', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      student,
      `insert into public.courses (profile_id, title) values ($1, 'Forged Course')
       returning profile_id`,
      [peer],
    )
    expect(rows[0]!.profile_id).toBe(student)
  })

  it('refuses to file a course under someone else\'s semester', async () => {
    // Otherwise semester_id is an existence oracle for a private row.
    const theirs = await newSemester(peer, 'Peer Term')

    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.courses (profile_id, semester_id, title)
           values ($1, $2, 'Borrowed')`,
          [student, theirs],
        ),
      /semester_not_owned|does not belong to you/i,
    )

    await db.asUser(peer, `delete from public.semesters where id = $1`, [theirs])
  })

  it('keeps a grade unreadable by anyone but its owner', async () => {
    // The single most damaging field in the schema.
    const course = await newCourse(student, 'CS301')
    await db.asUser(student, `update public.courses set grade = '1.0' where id = $1`, [course])

    const asPeer = await db.asUser(peer, `select grade from public.courses where id = $1`, [
      course,
    ])
    expect(asPeer).toHaveLength(0)

    const asOwner = await db.asUser<{ grade: string }>(
      student,
      `select grade from public.courses where id = $1`,
      [course],
    )
    expect(asOwner[0]!.grade).toBe('1.0')
  })

  it('is not readable by a moderator either', async () => {
    // Deliberate: there is no moderation use case for a transcript, and a
    // moderator who can browse everyone's grades is a breach waiting for an
    // excuse. If this test ever needs changing, that is the decision being made.
    const mod = await db.createUser({ username: 'coursemod', role: 'moderator' })
    const course = await newCourse(student, 'CS401')

    const rows = await db.asUser(mod, `select id from public.courses where id = $1`, [course])
    expect(rows).toHaveLength(0)
  })

  it('refuses a duplicate course code in the same term', async () => {
    const term = await newSemester(student, 'Dup Term')
    await newCourse(student, 'MATH101', term)

    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.courses (profile_id, semester_id, code, title)
           values ($1, $2, 'math101', 'Duplicate')`,
          [student, term],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('refuses a colour that is not a hex triple', async () => {
    // The value is interpolated into a style attribute, so it is constrained at
    // the database rather than trusted from the form.
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.courses (profile_id, title, color)
           values ($1, 'Injected', 'red; background: url(x)')`,
          [student],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses a client write to profile_id', async () => {
    const course = await newCourse(student, 'CS501')
    await expectRejection(
      () =>
        db.asUser(student, `update public.courses set profile_id = $2 where id = $1`, [
          course,
          peer,
        ]),
      /permission denied|cannot be modified/i,
    )
  })
})

// ===========================================================================
describe('goals', () => {
  it('derives progress_percent from the reported numbers', async () => {
    const goal = await newGoal(student, 'private', 'Progress maths')
    await db.asUser(student, `update public.goals set current_value = 3 where id = $1`, [goal])

    const rows = await db.asUser<{ progress_percent: number }>(
      student,
      `select progress_percent from public.goals where id = $1`,
      [goal],
    )
    // 3 of 12 papers.
    expect(rows[0]!.progress_percent).toBe(25)
  })

  it('floors rather than rounds, so nearly-done is not shown as done', async () => {
    const rows = await db.asUser<{ id: string; progress_percent: number }>(
      student,
      `insert into public.goals (profile_id, title, target_value, current_value)
       values ($1, 'Almost there', 1000, 999) returning id, progress_percent`,
      [student],
    )
    expect(rows[0]!.progress_percent).toBe(99)
  })

  it('refuses a direct write to progress_percent', async () => {
    // A generated column. Claiming completion has to mean moving current_value.
    const goal = await newGoal(student, 'private', 'No claiming')
    await expectRejection(
      () =>
        db.asUser(student, `update public.goals set progress_percent = 100 where id = $1`, [
          goal,
        ]),
      /permission denied|can only be updated to DEFAULT|cannot be modified/i,
    )
  })

  it('sets and clears completed_at from status', async () => {
    const goal = await newGoal(student, 'private', 'Round trip')

    await db.asUser(student, `update public.goals set status = 'completed' where id = $1`, [goal])
    let rows = await db.asUser<{ completed_at: string | null }>(
      student,
      `select completed_at from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.completed_at).not.toBeNull()

    await db.asUser(student, `update public.goals set status = 'active' where id = $1`, [goal])
    rows = await db.asUser<{ completed_at: string | null }>(
      student,
      `select completed_at from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.completed_at).toBeNull()
  })

  it('refuses a client write to completed_at', async () => {
    const goal = await newGoal(student, 'private', 'Backdated')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `update public.goals set completed_at = '2020-01-01' where id = $1`,
          [goal],
        ),
      /permission denied|cannot be modified/i,
    )
  })

  it('hides a private goal from everyone else', async () => {
    const goal = await newGoal(student, 'private', 'Private ambition')

    expect(await db.asUser(peer, `select id from public.goals where id = $1`, [goal])).toHaveLength(0)
    expect(await db.asAnon(`select id from public.goals where id = $1`, [goal])).toHaveLength(0)
  })

  it('shows a university goal to a classmate but not to an outsider', async () => {
    const goal = await newGoal(student, 'university', 'Shared with campus')

    expect(await db.asUser(peer, `select id from public.goals where id = $1`, [goal])).toHaveLength(1)
    expect(
      await db.asUser(outsider, `select id from public.goals where id = $1`, [goal]),
    ).toHaveLength(0)
  })

  it('shows a public goal to an anonymous visitor', async () => {
    const goal = await newGoal(student, 'public', 'Open ambition')
    const rows = await db.asAnon<{ title: string }>(
      `select title from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.title).toBe('Open ambition')
  })

  it('clamps a goal to the owner profile\'s visibility', async () => {
    // Same invariant as posts and projects: content cannot out-rank its author.
    const shy = await db.createUser({ username: 'quiet', visibility: 'connections' })
    const rows = await db.asUser<{ visibility: string }>(
      shy,
      `insert into public.goals (profile_id, title, visibility)
       values ($1, 'Loud goal, quiet profile', 'public') returning visibility`,
      [shy],
    )
    expect(rows[0]!.visibility).toBe('connections')
  })

  it('hides a shared goal once the viewer is blocked', async () => {
    const blocked = await db.createUser({ username: 'blockedviewer', universityId: uniA })
    const goal = await newGoal(student, 'public', 'Visible until blocked')

    expect(
      await db.asUser(blocked, `select id from public.goals where id = $1`, [goal]),
    ).toHaveLength(1)

    await db.asUser(
      student,
      `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`,
      [student, blocked],
    )

    expect(
      await db.asUser(blocked, `select id from public.goals where id = $1`, [goal]),
    ).toHaveLength(0)
  })

  it('refuses to anchor a goal to someone else\'s course', async () => {
    const theirs = await newCourse(peer, 'PEER101')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.goals (profile_id, title, course_id)
           values ($1, 'Borrowed course', $2)`,
          [student, theirs],
        ),
      /course_not_owned|does not belong to you/i,
    )
  })

  it('refuses to anchor a goal to a project the caller is not in', async () => {
    const proj = await db.asUser<{ id: string }>(
      peer,
      `insert into public.projects (owner_id, title, tagline, category)
       values ($1, 'Peer Project', 'Not yours', 'web') returning id`,
      [peer],
    )

    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.goals (profile_id, title, project_id)
           values ($1, 'Hijacked project goal', $2)`,
          [student, proj[0]!.id],
        ),
      /not_project_member|not a member/i,
    )
  })

  it('does not let another user edit or delete a goal', async () => {
    const goal = await newGoal(student, 'public', 'Not yours to touch')

    // RLS filters the row out, so the UPDATE affects nothing rather than erroring.
    await db.asUser(peer, `update public.goals set title = 'Hijacked' where id = $1`, [goal])
    await db.asUser(peer, `delete from public.goals where id = $1`, [goal])

    const rows = await db.asUser<{ title: string }>(
      student,
      `select title from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.title).toBe('Not yours to touch')
  })

  it('refuses a target of zero', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.goals (profile_id, title, target_value)
           values ($1, 'Divide by zero', 0)`,
          [student],
        ),
      REJECTS.checkViolation,
    )
  })
})

// ===========================================================================
describe('goal_milestones', () => {
  it('maintains the goal\'s milestone counters', async () => {
    const goal = await newGoal(student, 'private', 'Counted goal')

    const m = await db.asUser<{ id: string }>(
      student,
      `insert into public.goal_milestones (goal_id, title) values ($1, 'Step one')
       returning id`,
      [goal],
    )
    await db.asUser(
      student,
      `insert into public.goal_milestones (goal_id, title) values ($1, 'Step two')`,
      [goal],
    )

    let rows = await db.asUser<{ milestone_count: number; completed_milestone_count: number }>(
      student,
      `select milestone_count, completed_milestone_count from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.milestone_count).toBe(2)
    expect(rows[0]!.completed_milestone_count).toBe(0)

    await db.asUser(
      student,
      `update public.goal_milestones set is_completed = true where id = $1`,
      [m[0]!.id],
    )

    rows = await db.asUser<{ milestone_count: number; completed_milestone_count: number }>(
      student,
      `select milestone_count, completed_milestone_count from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.completed_milestone_count).toBe(1)

    await db.asUser(student, `delete from public.goal_milestones where id = $1`, [m[0]!.id])
    rows = await db.asUser<{ milestone_count: number; completed_milestone_count: number }>(
      student,
      `select milestone_count, completed_milestone_count from public.goals where id = $1`,
      [goal],
    )
    expect(rows[0]!.milestone_count).toBe(1)
    expect(rows[0]!.completed_milestone_count).toBe(0)
  })

  it('sets completed_at from is_completed and clears it again', async () => {
    const goal = await newGoal(student, 'private', 'Milestone dates')
    const m = await db.asUser<{ id: string; completed_at: string | null }>(
      student,
      `insert into public.goal_milestones (goal_id, title, is_completed)
       values ($1, 'Done at once', true) returning id, completed_at`,
      [goal],
    )
    expect(m[0]!.completed_at).not.toBeNull()

    await db.asUser(
      student,
      `update public.goal_milestones set is_completed = false where id = $1`,
      [m[0]!.id],
    )
    const rows = await db.asUser<{ completed_at: string | null }>(
      student,
      `select completed_at from public.goal_milestones where id = $1`,
      [m[0]!.id],
    )
    expect(rows[0]!.completed_at).toBeNull()
  })

  it('follows the goal\'s visibility for reads', async () => {
    const priv = await newGoal(student, 'private', 'Private with steps')
    const open = await newGoal(student, 'public', 'Public with steps')

    await db.asUser(
      student,
      `insert into public.goal_milestones (goal_id, title) values ($1, 'Secret step')`,
      [priv],
    )
    await db.asUser(
      student,
      `insert into public.goal_milestones (goal_id, title) values ($1, 'Open step')`,
      [open],
    )

    const visible = await db.asUser<{ title: string }>(
      peer,
      `select title from public.goal_milestones where goal_id = any($1::uuid[])`,
      [[priv, open]],
    )
    expect(visible.map((r) => r.title)).toEqual(['Open step'])
  })

  it('refuses a milestone attached to another user\'s goal', async () => {
    const theirs = await newGoal(peer, 'public', 'Peer goal')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.goal_milestones (goal_id, title) values ($1, 'Injected step')`,
          [theirs],
        ),
      REJECTS.rlsViolation,
    )
  })

  it('does not let another user tick off a visible milestone', async () => {
    const goal = await newGoal(student, 'public', 'Public checklist')
    const m = await db.asUser<{ id: string }>(
      student,
      `insert into public.goal_milestones (goal_id, title) values ($1, 'Mine to tick')
       returning id`,
      [goal],
    )

    await db.asUser(
      peer,
      `update public.goal_milestones set is_completed = true where id = $1`,
      [m[0]!.id],
    )

    const rows = await db.asUser<{ is_completed: boolean }>(
      student,
      `select is_completed from public.goal_milestones where id = $1`,
      [m[0]!.id],
    )
    expect(rows[0]!.is_completed).toBe(false)
  })
})

// ===========================================================================
describe('study_sessions', () => {
  it('generates ended_at from the duration', async () => {
    const rows = await db.asUser<{ span_minutes: number }>(
      student,
      `insert into public.study_sessions (profile_id, started_at, duration_minutes)
       values ($1, '2026-03-01T09:00:00Z', 90)
       returning extract(epoch from (ended_at - started_at)) / 60 as span_minutes`,
      [student],
    )
    expect(Number(rows[0]!.span_minutes)).toBe(90)
  })

  it('refuses a session dated in the future', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.study_sessions (profile_id, started_at, duration_minutes)
           values ($1, now() + interval '3 days', 60)`,
          [student],
        ),
      /cannot start in the future|started_at_future/i,
    )
  })

  it('refuses a duration longer than a day', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.study_sessions (profile_id, duration_minutes)
           values ($1, 5000)`,
          [student],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses a session attached to another user\'s course', async () => {
    const theirs = await newCourse(peer, 'PEER202')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.study_sessions (profile_id, course_id, duration_minutes)
           values ($1, $2, 60)`,
          [student, theirs],
        ),
      /course_not_owned|does not belong to you/i,
    )
  })

  it('refuses a session attached to another user\'s goal, even a public one', async () => {
    const theirs = await newGoal(peer, 'public', 'Peer public goal')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.study_sessions (profile_id, goal_id, duration_minutes)
           values ($1, $2, 60)`,
          [student, theirs],
        ),
      /goal_not_owned|does not belong to you/i,
    )
  })

  it('hides one student\'s sessions from another', async () => {
    const rows = await db.asUser<{ id: string }>(
      student,
      `insert into public.study_sessions (profile_id, duration_minutes)
       values ($1, 45) returning id`,
      [student],
    )

    expect(
      await db.asUser(peer, `select id from public.study_sessions where id = $1`, [rows[0]!.id]),
    ).toHaveLength(0)
  })
})

// ===========================================================================
describe('daily_logs', () => {
  it('allows one row per day and refuses a second', async () => {
    await db.asUser(
      student,
      `insert into public.daily_logs (profile_id, log_date, mood, summary)
       values ($1, '2026-03-02', 4, 'Good day')`,
      [student],
    )

    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.daily_logs (profile_id, log_date, mood)
           values ($1, '2026-03-02', 2)`,
          [student],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('refuses a log dated in the future', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.daily_logs (profile_id, log_date)
           values ($1, current_date + 5)`,
          [student],
        ),
      /cannot be dated in the future|log_date_future/i,
    )
  })

  it('refuses a mood outside the declared scale', async () => {
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.daily_logs (profile_id, log_date, mood)
           values ($1, '2026-03-03', 9)`,
          [student],
        ),
      REJECTS.checkViolation,
    )
  })

  it('is invisible to every other user, moderators included', async () => {
    const mod = await db.createUser({ username: 'logmod', role: 'moderator' })

    await db.asUser(
      student,
      `insert into public.daily_logs (profile_id, log_date, summary)
       values ($1, '2026-03-04', 'Struggled today')`,
      [student],
    )

    expect(
      await db.asUser(peer, `select summary from public.daily_logs where profile_id = $1`, [
        student,
      ]),
    ).toHaveLength(0)
    expect(
      await db.asUser(mod, `select summary from public.daily_logs where profile_id = $1`, [
        student,
      ]),
    ).toHaveLength(0)
  })

  it('cannot have its log_date rewritten to occupy another day', async () => {
    const rows = await db.asUser<{ id: string }>(
      student,
      `insert into public.daily_logs (profile_id, log_date) values ($1, '2026-03-05')
       returning id`,
      [student],
    )
    await expectRejection(
      () =>
        db.asUser(
          student,
          `update public.daily_logs set log_date = '2026-03-06' where id = $1`,
          [rows[0]!.id],
        ),
      /permission denied|cannot be modified/i,
    )
  })
})

// ===========================================================================
describe('current_study_streak', () => {
  it('counts consecutive days and stops at the first gap', async () => {
    const streaker = await db.createUser({ username: 'streaker' })

    // Today, yesterday, the day before -- then a gap, then two older days that
    // must not be counted.
    await db.asUser(
      streaker,
      `insert into public.daily_logs (profile_id, log_date)
       select $1, d::date from unnest(array[
         current_date, current_date - 1, current_date - 2,
         current_date - 5, current_date - 6
       ]) as d`,
      [streaker],
    )

    const rows = await db.asUser<{ streak: number }>(
      streaker,
      `select public.current_study_streak() as streak`,
    )
    expect(rows[0]!.streak).toBe(3)
  })

  it('keeps the streak alive when the most recent log is yesterday', async () => {
    // Today is not over. Resetting at midnight would be reported as a bug.
    const yesterdayOnly = await db.createUser({ username: 'yesterdayonly' })
    await db.asUser(
      yesterdayOnly,
      `insert into public.daily_logs (profile_id, log_date)
       select $1, d::date from unnest(array[current_date - 1, current_date - 2]) as d`,
      [yesterdayOnly],
    )

    const rows = await db.asUser<{ streak: number }>(
      yesterdayOnly,
      `select public.current_study_streak() as streak`,
    )
    expect(rows[0]!.streak).toBe(2)
  })

  it('is zero once the chain is broken', async () => {
    const lapsed = await db.createUser({ username: 'lapsed' })
    await db.asUser(
      lapsed,
      `insert into public.daily_logs (profile_id, log_date)
       select $1, d::date from unnest(array[current_date - 4, current_date - 5]) as d`,
      [lapsed],
    )

    const rows = await db.asUser<{ streak: number }>(
      lapsed,
      `select public.current_study_streak() as streak`,
    )
    expect(rows[0]!.streak).toBe(0)
  })

  it('is zero, not an error, for someone with no logs at all', async () => {
    const fresh = await db.createUser({ username: 'freshstart' })
    const rows = await db.asUser<{ streak: number }>(
      fresh,
      `select public.current_study_streak() as streak`,
    )
    expect(rows[0]!.streak).toBe(0)
  })

  it('only ever counts the caller\'s own days', async () => {
    // The function takes no arguments precisely so that it cannot be pointed at
    // another profile.
    const other = await db.createUser({ username: 'busybee' })
    await db.asUser(
      other,
      `insert into public.daily_logs (profile_id, log_date)
       select $1, d::date from unnest(array[
         current_date, current_date - 1, current_date - 2, current_date - 3
       ]) as d`,
      [other],
    )

    const idle = await db.createUser({ username: 'idle' })
    const rows = await db.asUser<{ streak: number }>(
      idle,
      `select public.current_study_streak() as streak`,
    )
    expect(rows[0]!.streak).toBe(0)
  })
})

// ===========================================================================
describe('posts.goal_id anchor', () => {
  it('accepts a learning update anchored to the author\'s own goal', async () => {
    const goal = await newGoal(student, 'public', 'Anchored goal')
    const rows = await db.asUser<{ goal_id: string }>(
      student,
      `insert into public.posts (author_id, type, body, goal_id, visibility)
       values ($1, 'learning_update', 'Three papers down', $2, 'public')
       returning goal_id`,
      [student, goal],
    )
    expect(rows[0]!.goal_id).toBe(goal)
  })

  it('refuses a post anchored to another user\'s goal', async () => {
    const theirs = await newGoal(peer, 'public', 'Peer goal for posts')
    await expectRejection(
      () =>
        db.asUser(
          student,
          `insert into public.posts (author_id, type, body, goal_id)
           values ($1, 'learning_update', 'Not my goal', $2)`,
          [student, theirs],
        ),
      /goal_not_owned|does not belong to you/i,
    )
  })

  it('clamps the post to the goal\'s visibility', async () => {
    // The card renders the goal title, so a public post about a private goal
    // would publish that title.
    const goal = await newGoal(student, 'connections', 'Semi-private goal')
    const rows = await db.asUser<{ visibility: string }>(
      student,
      `insert into public.posts (author_id, type, body, goal_id, visibility)
       values ($1, 'learning_update', 'Progress', $2, 'public')
       returning visibility`,
      [student, goal],
    )
    expect(rows[0]!.visibility).toBe('connections')
  })

  it('re-clamps existing posts when the goal is made private', async () => {
    const goal = await newGoal(student, 'public', 'Public then private')
    const post = await db.asUser<{ id: string }>(
      student,
      `insert into public.posts (author_id, type, body, goal_id, visibility)
       values ($1, 'learning_update', 'Going well', $2, 'public') returning id`,
      [student, goal],
    )

    await db.asUser(student, `update public.goals set visibility = 'private' where id = $1`, [
      goal,
    ])

    // The clamp is applied on every write to the post, so the next edit pulls it
    // down. Backfilling every existing post the instant a goal changes is a
    // moderation-scale job, not a trigger -- documented in docs/DATABASE.md.
    await db.asUser(student, `update public.posts set body = 'Still going' where id = $1`, [
      post[0]!.id,
    ])

    const rows = await db.asUser<{ visibility: string }>(
      student,
      `select visibility from public.posts where id = $1`,
      [post[0]!.id],
    )
    expect(rows[0]!.visibility).toBe('private')
  })

  it('nulls the anchor rather than deleting the post when the goal is deleted', async () => {
    const goal = await newGoal(student, 'public', 'Doomed goal')
    const post = await db.asUser<{ id: string }>(
      student,
      `insert into public.posts (author_id, type, body, goal_id)
       values ($1, 'learning_update', 'Survives its goal', $2) returning id`,
      [student, goal],
    )

    await db.asUser(student, `delete from public.goals where id = $1`, [goal])

    const rows = await db.asUser<{ goal_id: string | null }>(
      student,
      `select goal_id from public.posts where id = $1`,
      [post[0]!.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.goal_id).toBeNull()
  })
})
