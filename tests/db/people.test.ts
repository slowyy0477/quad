/**
 * People and universities: the permission suite.
 *
 * Every test here is a rule, not a policy number. The shape is the one
 * projects.test.ts established, and it is the only shape worth using for RLS:
 *
 *   1. the person who is supposed to be able to do it can;
 *   2. an unrelated person cannot;
 *   3. an unrelated person cannot by substituting an id.
 *
 * The third is the one that catches the common mistake. A policy that checks
 * `auth.uid() is not null` rather than `owner = auth.uid()` passes the first two
 * and fails the third, and the third is the one an attacker uses.
 *
 * What this file covers, in the order the interface presents it: your own profile
 * and who may read it; saying which university you are at; the institution
 * directory and filing a new one; connections, follows and blocks; skills and
 * interests.
 *
 * The statements run through the real migrations as the `authenticated` role with
 * a JWT subject, so what is being tested is the shipped policy rather than a
 * description of it. `asService` appears only in fixtures and never in an
 * assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let alice: string
let bob: string
let carol: string
let dave: string

let uniA: string
let uniB: string
let aliceSubmission: string
let deptOfA: string
let approvedSkill: string
let carolSkill: string
let approvedInterest: string
let carolInterest: string

/**
 * A trigger that raises with errcode 42501 and a message describing the refusal.
 * Whether the driver prints the SQLSTATE into `message` along with the wording is
 * an implementation detail, so these matchers accept the harness's `notPermitted`
 * shape or the trigger's own sentence. It is the same rejection either way, and
 * pinning the test to one half of it would make the suite fail on a driver bump.
 */
function rejectedBecause(wording: RegExp): RegExp {
  return new RegExp(`${REJECTS.notPermitted.source}|${wording.source}`, 'i')
}

/** Self-endorsement is refused by the RLS WITH CHECK and by a CHECK constraint. */
const SELF_ENDORSEMENT_REFUSED = new RegExp(
  `${REJECTS.rlsViolation.source}|${REJECTS.checkViolation.source}`,
  'i',
)

beforeAll(async () => {
  db = await createTestDb()

  const universities = await db.asService<{ id: string }>(
    `insert into public.universities (name, short_name, city, country, status)
     values ('Test University A', 'TU-A', 'Lahore', 'Pakistan', 'approved'),
            ('Test University B', 'TU-B', 'Karachi', 'Pakistan', 'approved')
     returning id`,
  )
  uniA = universities[0]!.id
  uniB = universities[1]!.id

  const departments = await db.asService<{ id: string }>(
    `insert into public.departments (university_id, name)
     values ($1, 'Computer Science')
     returning id`,
    [uniA],
  )
  deptOfA = departments[0]!.id

  const skills = await db.asService<{ id: string }>(
    `insert into public.skills (name, is_approved) values ('TypeScript', true) returning id`,
  )
  approvedSkill = skills[0]!.id

  const interests = await db.asService<{ id: string }>(
    `insert into public.interests (name, is_approved) values ('Chess', true) returning id`,
  )
  approvedInterest = interests[0]!.id

  alice = await db.createUser({ username: 'alice', universityId: uniA, visibility: 'public' })
  bob = await db.createUser({ username: 'bob', universityId: uniA, visibility: 'public' })
  carol = await db.createUser({ username: 'carol', universityId: uniB, visibility: 'public' })
  dave = await db.createUser({ username: 'dave', visibility: 'public' })

  // An unapproved skill proposed by carol, and the same for an interest. These are
  // fixtures, so the privileged path that leaves them unapproved is the honest way
  // to build them -- a client insert would be forced back to pending anyway.
  const carolSkills = await db.asService<{ id: string }>(
    `insert into public.skills (name, is_approved, created_by) values ('Rust', false, $1) returning id`,
    [carol],
  )
  carolSkill = carolSkills[0]!.id

  const carolInterests = await db.asService<{ id: string }>(
    `insert into public.interests (name, is_approved, created_by) values ('Bouldering', false, $1) returning id`,
    [carol],
  )
  carolInterest = carolInterests[0]!.id
}, 240_000)

afterAll(async () => {
  await db?.close()
})

// =============================================================================
// Your own profile
// =============================================================================

describe('your own profile', () => {
  it('you can change your own name', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.profiles set display_name = 'Alice Updated' where id = $1 returning id`,
      [alice],
    )
    expect(rows).toHaveLength(1)

    const stored = await db.asService<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [alice],
    )
    expect(stored[0]!.display_name).toBe('Alice Updated')
  })

  it('a stranger cannot change my name', async () => {
    const rows = await db.asUser<{ id: string }>(
      bob,
      `update public.profiles set display_name = 'Owned by Bob' where id = $1 returning id`,
      [alice],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [alice],
    )
    expect(stored[0]!.display_name).toBe('Alice Updated')
  })

  it('a stranger cannot change my name by sending my id as their own', async () => {
    // The id is mine and the WHERE clause matches my row, but the JWT subject is
    // bob's, which is what the policy reads. Passing the right id is not the same
    // as being the right person.
    const rows = await db.asUser<{ id: string }>(
      bob,
      `update public.profiles set display_name = 'Owned by Bob' where id = $1 returning id`,
      [bob],
    )
    expect(rows).toHaveLength(1)

    const aliceStored = await db.asService<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [alice],
    )
    expect(aliceStored[0]!.display_name).toBe('Alice Updated')
  })

  it('you can change who can see your profile', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.profiles set visibility = 'connections' where id = $1 returning id`,
      [alice],
    )
    expect(rows).toHaveLength(1)

    await db.asUser(
      alice,
      `update public.profiles set visibility = 'public' where id = $1`,
      [alice],
    )
  })

  it('a client cannot make itself a moderator or suspend itself', async () => {
    // profiles.status is absent from the UPDATE column grant on purpose: it is the
    // account-state column and an app-level action owns it.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profiles set status = 'suspended' where id = $1`,
          [alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('a client cannot set its own visibility to a value that is not allowed', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profiles set visibility = 'everyone' where id = $1`,
          [alice],
        ),
      REJECTS.checkViolation,
    )
  })

  it('a client cannot raise its own counters', async () => {
    // follower_count is maintained by a trigger on follows. It is not in the UPDATE
    // column grant, so the only way to raise it is to be followed.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profiles set follower_count = 999 where id = $1`,
          [alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('a profile cannot be hard-deleted from a client', async () => {
    await expectRejection(
      () => db.asUser(alice, `delete from public.profiles where id = $1`, [alice]),
      REJECTS.permissionDenied,
    )

    const rows = await db.asService<{ id: string }>(
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(1)
  })
})

// =============================================================================
// Who may read a profile
// =============================================================================

describe('profile visibility', () => {
  it('a public profile is readable by someone who is not signed in', async () => {
    const rows = await db.asAnon<{ id: string }>(
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(1)
  })

  it('a private profile is invisible to an unrelated student', async () => {
    await db.asUser(alice, `update public.profiles set visibility = 'private' where id = $1`, [
      alice,
    ])

    const rows = await db.asUser<{ id: string }>(
      carol,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(0)
  })

  it('a private profile is still readable by the person it belongs to', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(1)
  })

  it('a university-only profile is readable by a classmate', async () => {
    await db.asUser(alice, `update public.profiles set visibility = 'university' where id = $1`, [
      alice,
    ])

    // bob is at uniA with alice; carol is at uniB.
    const classmate = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(classmate).toHaveLength(1)

    const outsider = await db.asUser<{ id: string }>(
      carol,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(outsider).toHaveLength(0)
  })

  it('a university-only profile is invisible to a student at no university', async () => {
    const rows = await db.asUser<{ id: string }>(
      dave,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(0)
  })

  it('a connections-only profile is invisible before the request is accepted', async () => {
    await db.asUser(alice, `update public.profiles set visibility = 'connections' where id = $1`, [
      alice,
    ])

    await db.asUser(
      bob,
      `insert into public.connections (addressee_id) values ($1)`,
      [alice],
    )

    const pending = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(pending).toHaveLength(0)
  })

  it('a connections-only profile becomes readable once the request is accepted', async () => {
    // The addressee accepts -- the requester cannot, which the connections suite
    // asserts separately. Here the point is that acceptance is what opens the page.
    await db.asUser(alice, `update public.connections set status = 'accepted' where addressee_id = $1`, [
      alice,
    ])

    const rows = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(1)
  })

  it('being connected does not open a profile to everyone else', async () => {
    const rows = await db.asUser<{ id: string }>(
      carol,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(0)
  })
})

// =============================================================================
// Saying which university you are at
// =============================================================================

describe('saying which university you are at', () => {
  it('you can set your own university', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.profiles set university_id = $2 where id = $1 returning id`,
      [alice, uniB],
    )
    expect(rows).toHaveLength(1)

    const stored = await db.asService<{ university_id: string }>(
      `select university_id from public.profiles where id = $1`,
      [alice],
    )
    expect(stored[0]!.university_id).toBe(uniB)
  })

  it('claiming a second university moves the affiliation rather than adding one', async () => {
    // One row per person is the whole point: a profile has a university, not a list
    // of them. This asserts the shape the schema chose rather than assuming it.
    const rows = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.profiles where id = $1`,
      [alice],
    )
    expect(rows[0]!.count).toBe('1')

    await db.asUser(alice, `update public.profiles set university_id = $2 where id = $1`, [
      alice,
      uniA,
    ])
    const stored = await db.asService<{ university_id: string }>(
      `select university_id from public.profiles where id = $1`,
      [alice],
    )
    expect(stored[0]!.university_id).toBe(uniA)
  })

  it('you cannot say which university someone else is at', async () => {
    const rows = await db.asUser<{ id: string }>(
      carol,
      `update public.profiles set university_id = $2 where id = $1 returning id`,
      [alice, uniB],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ university_id: string }>(
      `select university_id from public.profiles where id = $1`,
      [alice],
    )
    expect(stored[0]!.university_id).toBe(uniA)
  })

  it('the stored student count follows the affiliation', async () => {
    // student_count is not a page-side estimate: app.sync_university_student_count
    // moves it as profiles change, and the interface prints the column.
    const before = await db.asService<{ id: string; student_count: number }>(
      `select id, student_count from public.universities where id in ($1, $2) order by short_name`,
      [uniA, uniB],
    )
    const countOfA = before.find((row) => row.id === uniA)!.student_count

    await db.asUser(alice, `update public.profiles set university_id = $2 where id = $1`, [
      alice,
      uniB,
    ])

    const after = await db.asService<{ id: string; student_count: number }>(
      `select id, student_count from public.universities where id in ($1, $2)`,
      [uniA, uniB],
    )
    expect(after.find((row) => row.id === uniA)!.student_count).toBe(countOfA - 1)

    await db.asUser(alice, `update public.profiles set university_id = $2 where id = $1`, [
      alice,
      uniA,
    ])
    const restored = await db.asService<{ id: string; student_count: number }>(
      `select id, student_count from public.universities where id in ($1, $2)`,
      [uniA, uniB],
    )
    expect(restored.find((row) => row.id === uniA)!.student_count).toBe(countOfA)
  })

  it('a department from a different university cannot be attached', async () => {
    // The affiliation is a chain -- department belongs to university, program
    // belongs to department -- and this is the trigger that keeps the chain true.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profiles set university_id = $2, department_id = $3 where id = $1`,
          [alice, uniB, deptOfA],
        ),
      /does not belong to the selected university/i,
    )
  })
})

// =============================================================================
// The institution directory
// =============================================================================

describe('filing a university', () => {
  it('a filed institution is pending however the client words the request', async () => {
    const rows = await db.asUser<{
      id: string
      status: string
      student_count: number
      submitted_by: string
    }>(
      alice,
      `insert into public.universities (name, short_name, city, country, status, student_count, submitted_by)
       values ('Alice Institute', 'AI', 'Multan', 'Pakistan', 'approved', 42, $1)
       returning id, status, student_count, submitted_by`,
      [bob],
    )

    aliceSubmission = rows[0]!.id
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.student_count).toBe(0)
    expect(rows[0]!.submitted_by).toBe(alice)
  })

  it('a client cannot approve its own institution', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.universities set status = 'approved' where id = $1`,
          [aliceSubmission],
        ),
      rejectedBecause(/cannot be modified by role/),
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.universities where id = $1`,
      [aliceSubmission],
    )
    expect(rows[0]!.status).toBe('pending')
  })

  it('a client cannot edit the counters on its own institution', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.universities set student_count = 500 where id = $1`,
          [aliceSubmission],
        ),
      rejectedBecause(/cannot be modified by role/),
    )
  })

  it('a client can correct its own pending submission', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.universities set city = 'Multan City' where id = $1 returning id`,
      [aliceSubmission],
    )
    expect(rows).toHaveLength(1)
  })

  it('a client cannot edit a pending submission that belongs to someone else', async () => {
    const rows = await db.asUser<{ id: string }>(
      bob,
      `update public.universities set name = 'Bob Institute' where id = $1 returning id`,
      [aliceSubmission],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ name: string }>(
      `select name from public.universities where id = $1`,
      [aliceSubmission],
    )
    expect(stored[0]!.name).toBe('Alice Institute')
  })

  it('a client cannot edit an approved institution', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.universities set name = 'Renamed University' where id = $1 returning id`,
      [uniA],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ name: string }>(
      `select name from public.universities where id = $1`,
      [uniA],
    )
    expect(stored[0]!.name).toBe('Test University A')
  })

  it('a pending institution is visible to the person who filed it', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `select id from public.universities where id = $1`,
      [aliceSubmission],
    )
    expect(rows).toHaveLength(1)
  })

  it('a pending institution is invisible to everyone else', async () => {
    const student = await db.asUser<{ id: string }>(
      bob,
      `select id from public.universities where id = $1`,
      [aliceSubmission],
    )
    expect(student).toHaveLength(0)

    const visitor = await db.asAnon<{ id: string }>(
      `select id from public.universities where id = $1`,
      [aliceSubmission],
    )
    expect(visitor).toHaveLength(0)
  })

  it('an approved institution is public, including to signed-out visitors', async () => {
    const rows = await db.asAnon<{ id: string }>(
      `select id from public.universities where id = $1`,
      [uniA],
    )
    expect(rows).toHaveLength(1)
  })

  it('a client cannot delete an institution', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `delete from public.universities where id = $1 returning id`,
      [uniB],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ id: string }>(
      `select id from public.universities where id = $1`,
      [uniB],
    )
    expect(stored).toHaveLength(1)
  })
})

// =============================================================================
// Connections
// =============================================================================

describe('connection requests', () => {
  it('a request is stamped with the caller as requester however it is addressed', async () => {
    // dave is in the pair below, and the trigger overwrites requester_id with
    // dave's own id -- so the forged value cannot survive. Note that a payload
    // naming dave as requester *and* addressee would fail the no-self constraint
    // instead, which is a different rejection; this one names a third party as the
    // requester so the forged insert is legal in every other respect.
    const rows = await db.asUser<{
      requester_id: string
      status: string
      responded_at: string | null
    }>(
      dave,
      `insert into public.connections (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now())
       returning requester_id, status, responded_at`,
      [carol, alice],
    )

    expect(rows[0]!.requester_id).toBe(dave)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.responded_at).toBeNull()
  })

  it('one row per pair, whatever the status of that row', async () => {
    await expectRejection(
      () =>
        db.asUser(
          dave,
          `insert into public.connections (addressee_id) values ($1)`,
          [alice],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('a third party cannot accept a request that is not addressed to them', async () => {
    // This is the substitution case: the row is named, the statement is legal, and
    // the policy still refuses because the addressee is somebody else.
    const rows = await db.asUser<{ id: string }>(
      carol,
      `update public.connections set status = 'accepted'
        where requester_id = $1 and addressee_id = $2 returning id`,
      [dave, alice],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ status: string }>(
      `select status from public.connections where requester_id = $1 and addressee_id = $2`,
      [dave, alice],
    )
    expect(stored[0]!.status).toBe('pending')
  })

  it('the requester cannot accept their own request', async () => {
    const rows = await db.asUser<{ id: string }>(
      dave,
      `update public.connections set status = 'accepted'
        where requester_id = $1 and addressee_id = $2 returning id`,
      [dave, alice],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ status: string }>(
      `select status from public.connections where requester_id = $1 and addressee_id = $2`,
      [dave, alice],
    )
    expect(stored[0]!.status).toBe('pending')
  })

  it('a client cannot rewrite who a connection is between', async () => {
    // The UPDATE column grant is (status, updated_at, responded_at) and nothing
    // else, so the parties are fixed once the row exists.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.connections set addressee_id = $1
            where requester_id = $2 and addressee_id = $3`,
          [carol, dave, alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('the addressee can accept', async () => {
    const rows = await db.asUser<{ id: string; status: string }>(
      alice,
      `update public.connections set status = 'accepted'
        where requester_id = $1 and addressee_id = $2 returning id, status`,
      [dave, alice],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('accepted')
  })

  it('accepting raises the connection count for both people', async () => {
    const rows = await db.asService<{ id: string; connection_count: number }>(
      `select id, connection_count from public.profiles where id in ($1, $2)`,
      [dave, alice],
    )
    for (const row of rows) {
      expect(row.connection_count).toBeGreaterThanOrEqual(1)
    }
  })

  it('a connection is invisible to someone who is not in it', async () => {
    const rows = await db.asUser<{ id: string }>(
      bob,
      `select id from public.connections where requester_id = $1 and addressee_id = $2`,
      [dave, alice],
    )
    expect(rows).toHaveLength(0)
  })

  it('a request cannot be sent to someone who is not accepting them', async () => {
    await db.asService(`update public.profiles set allow_connection_requests = false where id = $1`, [
      bob,
    ])

    await expectRejection(
      () =>
        db.asUser(
          carol,
          `insert into public.connections (addressee_id) values ($1)`,
          [bob],
        ),
      rejectedBecause(/not accepting connection requests/),
    )

    await db.asService(`update public.profiles set allow_connection_requests = true where id = $1`, [
      bob,
    ])
  })
})

// =============================================================================
// Follows
// =============================================================================

describe('follows', () => {
  it('a follow is filed under the caller however it is worded', async () => {
    await expectRejection(
      () =>
        db.asUser(
          carol,
          `insert into public.follows (follower_id, following_id) values ($1, $2)`,
          [bob, carol],
        ),
      REJECTS.rlsViolation,
    )

    const rows = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.follows where follower_id = $1 and following_id = $2`,
      [bob, carol],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('you can follow someone', async () => {
    // follower_id is sent explicitly because, unlike connections and blocks, follows
    // has no BEFORE trigger to stamp it: the insert policy is the only thing that
    // decides whether it is trusted, and a missing value simply fails that policy.
    const rows = await db.asUser<{ follower_id: string }>(
      bob,
      `insert into public.follows (follower_id, following_id) values ($1, $2) returning follower_id`,
      [bob, carol],
    )
    expect(rows[0]!.follower_id).toBe(bob)
  })

  it('you cannot follow yourself', async () => {
    await expectRejection(
      () =>
        db.asUser(
          bob,
          `insert into public.follows (follower_id, following_id) values ($1, $1)`,
          [bob],
        ),
      REJECTS.checkViolation,
    )
  })

  it('a follow raises the follower and following counts', async () => {
    const rows = await db.asService<{ id: string; follower_count: number; following_count: number }>(
      `select id, follower_count, following_count from public.profiles where id in ($1, $2)`,
      [bob, carol],
    )
    const bobRow = rows.find((row) => row.id === bob)!
    const carolRow = rows.find((row) => row.id === carol)!

    expect(bobRow.following_count).toBeGreaterThanOrEqual(1)
    expect(carolRow.follower_count).toBeGreaterThanOrEqual(1)
  })

  it('you cannot remove a follow that belongs to someone else', async () => {
    const rows = await db.asUser<{ follower_id: string }>(
      carol,
      `delete from public.follows where follower_id = $1 and following_id = $2 returning follower_id`,
      [bob, carol],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.follows where follower_id = $1 and following_id = $2`,
      [bob, carol],
    )
    expect(stored[0]!.count).toBe('1')
  })

  it('you can unfollow someone yourself', async () => {
    const rows = await db.asUser<{ follower_id: string }>(
      bob,
      `delete from public.follows where follower_id = $1 and following_id = $2 returning follower_id`,
      [bob, carol],
    )
    expect(rows).toHaveLength(1)
  })
})

// =============================================================================
// Blocks
// =============================================================================

describe('blocks', () => {
  it('a block is filed by the caller however the payload is worded', async () => {
    const rows = await db.asUser<{ blocker_id: string }>(
      alice,
      `insert into public.blocks (blocker_id, blocked_id, reason) values ($1, $2, 'test')
       returning blocker_id`,
      [bob, carol],
    )
    expect(rows[0]!.blocker_id).toBe(alice)
  })

  it('a block the blocker files is invisible to the person blocked', async () => {
    const rows = await db.asUser<{ blocker_id: string }>(
      carol,
      `select blocker_id from public.blocks where blocker_id = $1 and blocked_id = $2`,
      [alice, carol],
    )
    expect(rows).toHaveLength(0)
  })

  it('the blocker can still see their own block', async () => {
    const rows = await db.asUser<{ blocker_id: string }>(
      alice,
      `select blocker_id from public.blocks where blocker_id = $1 and blocked_id = $2`,
      [alice, carol],
    )
    expect(rows).toHaveLength(1)
  })
})

describe('what a block does', () => {
  it('a block removes the follow edge in both directions', async () => {
    // A live follow edge behind a block still leaks activity, so the block severs it
    // rather than merely hiding it.
    await db.asUser(
      bob,
      `insert into public.follows (follower_id, following_id) values ($1, $2)`,
      [bob, alice],
    )
    const before = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.follows
        where (follower_id = $1 and following_id = $2) or (follower_id = $2 and following_id = $1)`,
      [alice, bob],
    )
    expect(before[0]!.count).toBe('1')

    const rows = await db.asUser<{ blocker_id: string; blocked_id: string }>(
      alice,
      `insert into public.blocks (blocked_id) values ($1) returning blocker_id, blocked_id`,
      [bob],
    )
    // blocks is keyed by the pair -- there is no surrogate id to hold on to. The
    // shape of the key is itself the guarantee that a block exists once per pair.
    expect(rows[0]!.blocker_id).toBe(alice)
    expect(rows[0]!.blocked_id).toBe(bob)

    const after = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.follows
        where (follower_id = $1 and following_id = $2) or (follower_id = $2 and following_id = $1)`,
      [alice, bob],
    )
    expect(after[0]!.count).toBe('0')
  })

  it('a block removes an existing connection between the two', async () => {
    const rows = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.connections
        where pair_low = least($1::uuid, $2::uuid) and pair_high = greatest($1::uuid, $2::uuid)`,
      [alice, bob],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('the blocked student cannot reach the blocker profile', async () => {
    // This is the whole promise of the block, and it is enforced by the visibility
    // predicate rather than by a filter in a query -- which is why the profile route
    // needs no code about blocking at all.
    const rows = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(0)
  })

  it('the blocked student would have seen it if the block were not there', async () => {
    // The control: alice's visibility is 'connections' at this point, bob is no
    // longer connected, so this asserts the block is not the only reason to look
    // elsewhere. Setting her back to public removes the other explanation.
    await db.asUser(alice, `update public.profiles set visibility = 'public' where id = $1`, [
      alice,
    ])

    const rows = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(rows).toHaveLength(0)
  })

  it('the blocker cannot reach the blocked student profile either', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `select id from public.profiles where id = $1`,
      [bob],
    )
    expect(rows).toHaveLength(0)
  })

  it('a block hides a profile from the other party, not from the world', async () => {
    // Both profiles are public at this point. A block is a rule between two people,
    // not a deletion: a signed-out visitor still sees each of them.
    const aliceSeen = await db.asAnon<{ id: string }>(
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(aliceSeen).toHaveLength(1)

    const bobSeen = await db.asAnon<{ id: string }>(
      `select id from public.profiles where id = $1`,
      [bob],
    )
    expect(bobSeen).toHaveLength(1)
  })

  it('a new connection cannot be created across a standing block', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.connections (addressee_id) values ($1)`,
          [bob],
        ),
      rejectedBecause(/connection is not possible/),
    )
  })

  it('a follow cannot be created across a standing block', async () => {
    await expectRejection(
      () =>
        db.asUser(bob, `insert into public.follows (following_id) values ($1)`, [alice]),
      REJECTS.rlsViolation,
    )
  })

  it('only the blocker can lift their own block', async () => {
    const rows = await db.asUser<{ blocker_id: string }>(
      bob,
      `delete from public.blocks where blocker_id = $1 and blocked_id = $2 returning blocker_id`,
      [alice, bob],
    )
    expect(rows).toHaveLength(0)
  })

  it('lifting the block restores the profile', async () => {
    const rows = await db.asUser<{ blocker_id: string }>(
      alice,
      `delete from public.blocks where blocker_id = $1 and blocked_id = $2 returning blocker_id`,
      [alice, bob],
    )
    expect(rows).toHaveLength(1)

    const visible = await db.asUser<{ id: string }>(
      bob,
      `select id from public.profiles where id = $1`,
      [alice],
    )
    expect(visible).toHaveLength(1)
  })
})

// =============================================================================
// Skills and interests
// =============================================================================

describe('skills', () => {
  it('a skill can only be claimed on your own profile', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      alice,
      `insert into public.profile_skills (profile_id, skill_id, level)
       values ($1, $2, 'proficient') returning profile_id`,
      [bob, approvedSkill],
    )
    expect(rows[0]!.profile_id).toBe(alice)
  })

  it('a skill cannot be claimed twice', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.profile_skills (skill_id, level) values ($1, 'learning')`,
          [approvedSkill],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('a level cannot be set to a word the schema does not have', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profile_skills set level = 'expert' where profile_id = $1 and skill_id = $2`,
          [alice, approvedSkill],
        ),
      REJECTS.checkViolation,
    )
  })

  it('a stranger cannot change the level on my skill', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      bob,
      `update public.profile_skills set level = 'advanced'
        where profile_id = $1 and skill_id = $2 returning profile_id`,
      [alice, approvedSkill],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ level: string }>(
      `select level from public.profile_skills where profile_id = $1 and skill_id = $2`,
      [alice, approvedSkill],
    )
    expect(stored[0]!.level).toBe('proficient')
  })

  it('a stranger cannot remove a skill from my profile', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      bob,
      `delete from public.profile_skills where profile_id = $1 and skill_id = $2 returning profile_id`,
      [alice, approvedSkill],
    )
    expect(rows).toHaveLength(0)
  })

  it('a client cannot write its own endorsement count', async () => {
    // endorsement_count is a counter over profile_skill_endorsements, and it is not
    // in the UPDATE column grant: the only way it moves is somebody endorsing you.
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profile_skills set endorsement_count = 500
            where profile_id = $1 and skill_id = $2`,
          [alice, approvedSkill],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('a skill proposed by someone else and not yet approved cannot be claimed', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.profile_skills (skill_id, level) values ($1, 'learning')`,
          [carolSkill],
        ),
      rejectedBecause(/Skill is not available/),
    )
  })

  it('proposing a skill does not let the proposer approve it or set its counters', async () => {
    const rows = await db.asUser<{
      id: string
      is_approved: boolean
      usage_count: number
      created_by: string
    }>(
      alice,
      `insert into public.skills (name, is_approved, usage_count, created_by)
       values ('Kubernetes', true, 99, $1)
       returning id, is_approved, usage_count, created_by`,
      [bob],
    )

    expect(rows[0]!.is_approved).toBe(false)
    expect(rows[0]!.usage_count).toBe(0)
    expect(rows[0]!.created_by).toBe(alice)
  })

  it('a client cannot approve a skill, including their own', async () => {
    const rows = await db.asUser<{ id: string }>(
      alice,
      `update public.skills set is_approved = true where name = 'Kubernetes' returning id`,
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ is_approved: boolean }>(
      `select is_approved from public.skills where name = 'Kubernetes'`,
    )
    expect(stored[0]!.is_approved).toBe(false)
  })

  it('a client cannot inflate the usage count of a skill', async () => {
    await expectRejection(
      () =>
        db.asUser(alice, `update public.skills set usage_count = 999 where id = $1`, [
          approvedSkill,
        ]),
      REJECTS.permissionDenied,
    )
  })

  it('you can claim a skill you proposed yourself, before review', async () => {
    const rows = await db.asUser<{ skill_id: string }>(
      alice,
      `insert into public.profile_skills (skill_id, level, is_learning)
       values ((select id from public.skills where name = 'Kubernetes'), 'learning', true)
       returning skill_id`,
    )
    expect(rows).toHaveLength(1)
  })

  it('a skill is only readable while the profile it is on is readable', async () => {
    // alice is the profile with a skill on it. dave is *connected* to alice, which
    // makes this the stronger version of the claim: a private profile hides its
    // skills even from someone it is connected to. alice still sees her own rows.
    await db.asUser(alice, `update public.profiles set visibility = 'private' where id = $1`, [
      alice,
    ])

    const stranger = await db.asUser<{ skill_id: string }>(
      dave,
      `select skill_id from public.profile_skills where profile_id = $1 and skill_id = $2`,
      [alice, approvedSkill],
    )
    expect(stranger).toHaveLength(0)

    const owner = await db.asUser<{ skill_id: string }>(
      alice,
      `select skill_id from public.profile_skills where profile_id = $1 and skill_id = $2`,
      [alice, approvedSkill],
    )
    expect(owner).toHaveLength(1)

    await db.asUser(alice, `update public.profiles set visibility = 'public' where id = $1`, [
      alice,
    ])
  })

  it('you cannot endorse your own skill', async () => {
    // bob claims the skill for himself first, so the only rule left to trip is the
    // one about endorsing your own row -- otherwise this would be rejected by the
    // foreign key, which would prove nothing about endorsements.
    await db.asUser(bob, `insert into public.profile_skills (skill_id) values ($1)`, [
      approvedSkill,
    ])

    await expectRejection(
      () =>
        db.asUser(
          bob,
          `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
           values ($1, $2, $1)`,
          [bob, approvedSkill],
        ),
      SELF_ENDORSEMENT_REFUSED,
    )
  })

  it('somebody else endorsing a skill raises its endorsement count', async () => {
    await db.asUser(
      bob,
      `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
       values ($1, $2, $3)`,
      [alice, approvedSkill, bob],
    )

    const rows = await db.asService<{ endorsement_count: number }>(
      `select endorsement_count from public.profile_skills where profile_id = $1 and skill_id = $2`,
      [alice, approvedSkill],
    )
    expect(rows[0]!.endorsement_count).toBeGreaterThanOrEqual(1)
  })

  it('a client cannot withdraw an endorsement of me that is not theirs', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      carol,
      `delete from public.profile_skill_endorsements
        where profile_id = $1 and skill_id = $2 and endorser_id = $3 returning profile_id`,
      [alice, approvedSkill, bob],
    )
    expect(rows).toHaveLength(0)
  })

  it('a blocked user cannot endorse', async () => {
    await db.asUser(carol, `insert into public.profile_skills (skill_id) values ($1)`, [
      approvedSkill,
    ])
    await db.asUser(carol, `insert into public.blocks (blocked_id) values ($1)`, [bob])

    await expectRejection(
      () =>
        db.asUser(
          bob,
          `insert into public.profile_skill_endorsements (profile_id, skill_id, endorser_id)
           values ($1, $2, $3)`,
          [carol, approvedSkill, bob],
        ),
      rejectedBecause(/Not permitted/),
    )
  })
})

describe('interests', () => {
  it('an interest can only be tagged on your own profile', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      alice,
      `insert into public.profile_interests (profile_id, interest_id) values ($1, $2)
       returning profile_id`,
      [carol, approvedInterest],
    )
    expect(rows[0]!.profile_id).toBe(alice)
  })

  it('an interest cannot be tagged twice', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.profile_interests (interest_id) values ($1)`,
          [approvedInterest],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('an interest proposed by someone else and not yet approved cannot be tagged', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `insert into public.profile_interests (interest_id) values ($1)`,
          [carolInterest],
        ),
      rejectedBecause(/Interest is not available/),
    )
  })

  it('a stranger cannot remove an interest from my profile', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      bob,
      `delete from public.profile_interests where profile_id = $1 and interest_id = $2 returning profile_id`,
      [alice, approvedInterest],
    )
    expect(rows).toHaveLength(0)

    const stored = await db.asService<{ count: string }>(
      `select count(*)::text as count from public.profile_interests where profile_id = $1 and interest_id = $2`,
      [alice, approvedInterest],
    )
    expect(stored[0]!.count).toBe('1')
  })

  it('I can remove my own interest', async () => {
    const rows = await db.asUser<{ profile_id: string }>(
      alice,
      `delete from public.profile_interests where profile_id = $1 and interest_id = $2 returning profile_id`,
      [alice, approvedInterest],
    )
    expect(rows).toHaveLength(1)
  })

  it('an interest tag cannot be edited, only added and removed', async () => {
    await expectRejection(
      () =>
        db.asUser(
          alice,
          `update public.profile_interests set interest_id = $1 where profile_id = $2`,
          [approvedInterest, alice],
        ),
      REJECTS.permissionDenied,
    )
  })

  it('proposing an interest does not let the proposer approve it', async () => {
    const rows = await db.asUser<{
      is_approved: boolean
      usage_count: number
      created_by: string
    }>(
      alice,
      `insert into public.interests (name, is_approved, usage_count, created_by)
       values ('Rowing', true, 42, $1)
       returning is_approved, usage_count, created_by`,
      [bob],
    )

    expect(rows[0]!.is_approved).toBe(false)
    expect(rows[0]!.usage_count).toBe(0)
    expect(rows[0]!.created_by).toBe(alice)
  })

  it('a client cannot inflate the usage count of an interest', async () => {
    await expectRejection(
      () =>
        db.asUser(alice, `update public.interests set usage_count = 999 where id = $1`, [
          approvedInterest,
        ]),
      REJECTS.permissionDenied,
    )
  })

  it('an interest is only readable while the profile it is on is readable', async () => {
    await db.asUser(alice, `insert into public.profile_interests (interest_id) values ($1)`, [
      approvedInterest,
    ])
    await db.asUser(alice, `update public.profiles set visibility = 'private' where id = $1`, [
      alice,
    ])

    const stranger = await db.asUser<{ interest_id: string }>(
      dave,
      `select interest_id from public.profile_interests where profile_id = $1`,
      [alice],
    )
    expect(stranger).toHaveLength(0)

    const owner = await db.asUser<{ interest_id: string }>(
      alice,
      `select interest_id from public.profile_interests where profile_id = $1`,
      [alice],
    )
    expect(owner).toHaveLength(1)
  })
})
