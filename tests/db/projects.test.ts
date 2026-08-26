/**
 * Projects domain permission tests.
 *
 * The projects migration is the largest in the schema and carries the most
 * authorisation surface: ownership, membership roles, applications, invites,
 * visibility clamping and six denormalised counters. None of it had been
 * executed by a real user before these tests -- the schema smoke test only
 * proves the DDL applies.
 *
 * The properties worth pinning are the ones a client could otherwise talk its
 * way past: who owns a row, who may change it, who can see it, and whether the
 * numbers shown on a project page are facts or claims.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let owner: string
let outsider: string
let universityId: string

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('test-uni', 'Test University', 'approved') returning id`,
  )
  universityId = uni[0]!.id

  owner = await db.createUser({ username: 'projowner', universityId })
  outsider = await db.createUser({ username: 'projoutsider' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function createProject(
  userId: string,
  overrides: Partial<{ title: string; visibility: string; isSeeking: boolean }> = {},
) {
  const rows = await db.asUser<{ id: string }>(
    userId,
    `insert into public.projects (title, description, category, visibility, is_seeking_members)
     values ($1, 'A description long enough to be meaningful.', 'web', $2, $3)
     returning id`,
    [
      overrides.title ?? 'Test Project',
      overrides.visibility ?? 'public',
      overrides.isSeeking ?? true,
    ],
  )
  return rows[0]!.id
}

describe('project creation', () => {
  it('forces owner_id to the caller, ignoring a forged value', async () => {
    const rows = await db.asUser<{ id: string }>(
      owner,
      `insert into public.projects (title, description, category, owner_id)
       values ('Forged', 'A description long enough to be meaningful.', 'web', $1)
       returning id`,
      [outsider],
    )

    const project = await db.asService<{ owner_id: string }>(
      `select owner_id from public.projects where id = $1`,
      [rows[0]!.id],
    )
    expect(project[0]!.owner_id).toBe(owner)
  })

  it('zeroes the denormalised counters whatever the client sends', async () => {
    const rows = await db.asUser<{ id: string }>(
      owner,
      `insert into public.projects
         (title, description, category, star_count, member_count, application_count)
       values ('Inflated', 'A description long enough to be meaningful.', 'web',
               9999, 9999, 9999)
       returning id`,
    )

    const project = await db.asService<{
      star_count: number
      member_count: number
      application_count: number
    }>(
      `select star_count, member_count, application_count
         from public.projects where id = $1`,
      [rows[0]!.id],
    )
    expect(project[0]!.star_count).toBe(0)
    expect(project[0]!.application_count).toBe(0)
    // Not zero: the after-insert trigger has already added the owner as a member.
    expect(project[0]!.member_count).toBe(1)
  })

  it('adds the owner as a member with the owner role', async () => {
    const projectId = await createProject(owner)

    const members = await db.asService<{ profile_id: string; role: string }>(
      `select profile_id, role from public.project_members where project_id = $1`,
      [projectId],
    )
    expect(members).toHaveLength(1)
    expect(members[0]!.profile_id).toBe(owner)
    expect(members[0]!.role).toBe('owner')
  })

  it('denormalises the owner university onto the project', async () => {
    const projectId = await createProject(owner)

    const rows = await db.asService<{ university_id: string | null }>(
      `select university_id from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.university_id).toBe(universityId)
  })

  it('assigns a slug', async () => {
    const projectId = await createProject(owner, { title: 'Campus Ride Share' })

    const rows = await db.asService<{ slug: string }>(
      `select slug from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.slug).toMatch(/^campus-ride-share/)
  })

  it('refuses to let a client set moderation_status', async () => {
    const projectId = await createProject(owner)

    // Absent from the column-level UPDATE grant, so a project cannot approve
    // itself out of moderation.
    await expectRejection(
      () =>
        db.asUser(
          owner,
          `update public.projects set moderation_status = 'approved' where id = $1`,
          [projectId],
        ),
      REJECTS.permissionDenied,
    )
  })
})

describe('visibility', () => {
  it('clamps project visibility to the owner\'s profile visibility', async () => {
    // A private profile publishing a public project would leak the person
    // through the project page. The clamp is applied on write, so the stored
    // value never overstates what the owner has agreed to.
    const privateUser = await db.createUser({
      username: 'privateowner',
      visibility: 'connections',
    })

    const projectId = await createProject(privateUser, { visibility: 'public' })

    const rows = await db.asService<{ visibility: string }>(
      `select visibility from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.visibility).toBe('connections')
  })

  it('hides a private project from everyone but its members', async () => {
    const projectId = await createProject(owner, { visibility: 'private' })

    const asOutsider = await db.asUser(
      outsider,
      `select id from public.projects where id = $1`,
      [projectId],
    )
    expect(asOutsider).toEqual([])

    const asOwner = await db.asUser(owner, `select id from public.projects where id = $1`, [
      projectId,
    ])
    expect(asOwner).toHaveLength(1)
  })

  it('forces is_seeking_members off for a private project', async () => {
    // Advertising for members on a project nobody can see is incoherent, and
    // would put the project into discovery listings that then 404.
    const projectId = await createProject(owner, {
      visibility: 'private',
      isSeeking: true,
    })

    const rows = await db.asService<{ is_seeking_members: boolean }>(
      `select is_seeking_members from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.is_seeking_members).toBe(false)
  })

  it('shows a university-scoped project only to that university', async () => {
    const classmate = await db.createUser({ username: 'classmate', universityId })
    const projectId = await createProject(owner, { visibility: 'university' })

    const seen = await db.asUser(classmate, `select id from public.projects where id = $1`, [
      projectId,
    ])
    expect(seen).toHaveLength(1)

    // outsider has no university at all.
    const notSeen = await db.asUser(outsider, `select id from public.projects where id = $1`, [
      projectId,
    ])
    expect(notSeen).toEqual([])
  })

  it('hides projects from anonymous visitors entirely', async () => {
    await createProject(owner, { visibility: 'public' })

    await expectRejection(
      () => db.asAnon(`select id from public.projects`),
      REJECTS.permissionDenied,
    )
  })
})

describe('project ownership', () => {
  it('refuses a second owner row', async () => {
    const projectId = await createProject(owner)

    // A partial unique index on (project_id) where role = 'owner'. Two owners
    // would make every "can this person manage the project" answer ambiguous.
    await expectRejection(
      () =>
        db.asService(
          `insert into public.project_members (project_id, profile_id, role)
           values ($1, $2, 'owner')`,
          [projectId, outsider],
        ),
      // Two defences cover this -- the trigger and a partial unique index on
      // (project_id) where role = 'owner'. The trigger runs first.
      /exactly one owner|duplicate key value/i,
    )
  })

  it('refuses to remove the owner while the project exists', async () => {
    const projectId = await createProject(owner)

    await expectRejection(
      () =>
        db.asUser(
          owner,
          `delete from public.project_members where project_id = $1 and profile_id = $2`,
          [projectId, owner],
        ),
      /owner|42501|not permitted/i,
    )
  })

  it('still allows the project to be deleted, cascading its members', async () => {
    // The owner-removal guard has to check that the project still exists, or a
    // cascade delete trips over it and the project becomes undeletable.
    const projectId = await createProject(owner)

    await db.asService(`delete from public.projects where id = $1`, [projectId])

    const members = await db.asService(
      `select project_id from public.project_members where project_id = $1`,
      [projectId],
    )
    expect(members).toEqual([])
  })

  it('transfers ownership without violating the single-owner index', async () => {
    const projectId = await createProject(owner)
    const successor = await db.createUser({ username: 'successor', universityId })

    await db.asService(
      `insert into public.project_members (project_id, profile_id, role)
       values ($1, $2, 'maintainer')`,
      [projectId, successor],
    )

    await db.asUser(owner, `select public.transfer_project_ownership($1, $2)`, [
      projectId,
      successor,
    ])

    const rows = await db.asService<{ profile_id: string; role: string }>(
      `select profile_id, role from public.project_members
        where project_id = $1 order by role`,
      [projectId],
    )
    const roles = Object.fromEntries(rows.map((r) => [r.profile_id, r.role]))
    expect(roles[successor]).toBe('owner')
    expect(roles[owner]).not.toBe('owner')

    const project = await db.asService<{ owner_id: string }>(
      `select owner_id from public.projects where id = $1`,
      [projectId],
    )
    expect(project[0]!.owner_id).toBe(successor)
  })

  it('does not let a non-owner transfer ownership', async () => {
    const projectId = await createProject(owner)

    await expectRejection(
      () =>
        db.asUser(outsider, `select public.transfer_project_ownership($1, $2)`, [
          projectId,
          outsider,
        ]),
      /42501|not permitted|only the owner|permission/i,
    )
  })

  it('does not let a member promote themselves to owner', async () => {
    const projectId = await createProject(owner)
    const member = await db.createUser({ username: 'ambitious', universityId })
    await db.asService(
      `insert into public.project_members (project_id, profile_id, role)
       values ($1, $2, 'member')`,
      [projectId, member],
    )

    await expectRejection(
      () =>
        db.asUser(
          member,
          `update public.project_members set role = 'owner'
            where project_id = $1 and profile_id = $2`,
          [projectId, member],
        ),
      /owner|42501|not permitted|row-level security/i,
    )
  })
})

describe('project editing', () => {
  it('does not let an outsider edit the project', async () => {
    const projectId = await createProject(owner)

    // No error: the UPDATE policy filters the row out.
    await db.asUser(outsider, `update public.projects set title = 'Hijacked' where id = $1`, [
      projectId,
    ])

    const rows = await db.asService<{ title: string }>(
      `select title from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.title).toBe('Test Project')
  })

  it('does not let a plain member edit the project', async () => {
    const projectId = await createProject(owner)
    const member = await db.createUser({ username: 'plainmember', universityId })
    await db.asService(
      `insert into public.project_members (project_id, profile_id, role)
       values ($1, $2, 'member')`,
      [projectId, member],
    )

    await db.asUser(member, `update public.projects set title = 'Renamed' where id = $1`, [
      projectId,
    ])

    const rows = await db.asService<{ title: string }>(
      `select title from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.title).toBe('Test Project')
  })
})

describe('applications', () => {
  it('creates a membership when accepted, and only then', async () => {
    const projectId = await createProject(owner)
    const applicant = await db.createUser({ username: 'applicant1', universityId })

    const app = await db.asUser<{ id: string }>(
      applicant,
      `insert into public.project_applications (project_id, applicant_id, message)
       values ($1, $2, 'I would like to help') returning id`,
      [projectId, applicant],
    )

    let members = await db.asService(
      `select profile_id from public.project_members
        where project_id = $1 and profile_id = $2`,
      [projectId, applicant],
    )
    expect(members).toEqual([])

    await db.asUser(
      owner,
      `update public.project_applications set status = 'accepted' where id = $1`,
      [app[0]!.id],
    )

    members = await db.asService(
      `select profile_id from public.project_members
        where project_id = $1 and profile_id = $2`,
      [projectId, applicant],
    )
    expect(members).toHaveLength(1)
  })

  it('does not let an applicant accept their own application', async () => {
    // The escalation this schema is most exposed to: the applicant owns the row,
    // so a naive "you may update your own application" policy would be a
    // self-service join button.
    const projectId = await createProject(owner)
    const applicant = await db.createUser({ username: 'applicant2', universityId })

    const app = await db.asUser<{ id: string }>(
      applicant,
      `insert into public.project_applications (project_id, applicant_id)
       values ($1, $2) returning id`,
      [projectId, applicant],
    )

    // The applicant's own UPDATE policy allows exactly one transition -- pending
    // to withdrawn -- so the row is visible for update but the WITH CHECK
    // refuses any other target status outright.
    await expectRejection(
      () =>
        db.asUser(
          applicant,
          `update public.project_applications set status = 'accepted' where id = $1`,
          [app[0]!.id],
        ),
      REJECTS.rlsViolation,
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.project_applications where id = $1`,
      [app[0]!.id],
    )
    expect(rows[0]!.status).toBe('pending')

    const members = await db.asService(
      `select profile_id from public.project_members
        where project_id = $1 and profile_id = $2`,
      [projectId, applicant],
    )
    expect(members).toEqual([])
  })

  it('lets an applicant withdraw their own application', async () => {
    const projectId = await createProject(owner)
    const applicant = await db.createUser({ username: 'applicant3', universityId })

    const app = await db.asUser<{ id: string }>(
      applicant,
      `insert into public.project_applications (project_id, applicant_id)
       values ($1, $2) returning id`,
      [projectId, applicant],
    )

    await db.asUser(
      applicant,
      `update public.project_applications set status = 'withdrawn' where id = $1`,
      [app[0]!.id],
    )

    const rows = await db.asService<{ status: string }>(
      `select status from public.project_applications where id = $1`,
      [app[0]!.id],
    )
    expect(rows[0]!.status).toBe('withdrawn')
  })

  it('refuses an application to your own project', async () => {
    const projectId = await createProject(owner)

    await expectRejection(
      () =>
        db.asUser(
          owner,
          `insert into public.project_applications (project_id, applicant_id)
           values ($1, $2)`,
          [projectId, owner],
        ),
      /already own this project/i,
    )
  })

  it('refuses a second application to the same project', async () => {
    const projectId = await createProject(owner)
    const applicant = await db.createUser({ username: 'applicant4', universityId })

    await db.asUser(
      applicant,
      `insert into public.project_applications (project_id, applicant_id) values ($1, $2)`,
      [projectId, applicant],
    )

    await expectRejection(
      () =>
        db.asUser(
          applicant,
          `insert into public.project_applications (project_id, applicant_id) values ($1, $2)`,
          [projectId, applicant],
        ),
      REJECTS.uniqueViolation,
    )
  })

  it('refuses an application to a project that is not seeking members', async () => {
    const projectId = await createProject(owner, { isSeeking: false })
    const applicant = await db.createUser({ username: 'applicant5', universityId })

    await expectRejection(
      () =>
        db.asUser(
          applicant,
          `insert into public.project_applications (project_id, applicant_id) values ($1, $2)`,
          [projectId, applicant],
        ),
      /not accepting applications/i,
    )
  })

  it('does not let one applicant read another\'s application', async () => {
    const projectId = await createProject(owner)
    const a = await db.createUser({ username: 'applicant6', universityId })
    const b = await db.createUser({ username: 'applicant7', universityId })

    await db.asUser(
      a,
      `insert into public.project_applications (project_id, applicant_id, message)
       values ($1, $2, 'my private pitch')`,
      [projectId, a],
    )

    const seen = await db.asUser(
      b,
      `select message from public.project_applications where project_id = $1`,
      [projectId],
    )
    expect(seen).toEqual([])
  })

  it('counts only pending applications', async () => {
    const projectId = await createProject(owner)
    const a = await db.createUser({ username: 'applicant8', universityId })
    const b = await db.createUser({ username: 'applicant9', universityId })

    const appA = await db.asUser<{ id: string }>(
      a,
      `insert into public.project_applications (project_id, applicant_id)
       values ($1, $2) returning id`,
      [projectId, a],
    )
    await db.asUser(
      b,
      `insert into public.project_applications (project_id, applicant_id) values ($1, $2)`,
      [projectId, b],
    )

    let rows = await db.asService<{ application_count: number }>(
      `select application_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.application_count).toBe(2)

    await db.asUser(
      owner,
      `update public.project_applications set status = 'rejected' where id = $1`,
      [appA[0]!.id],
    )

    rows = await db.asService<{ application_count: number }>(
      `select application_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.application_count).toBe(1)
  })
})

describe('counters', () => {
  it('maintains member_count from the membership table', async () => {
    const projectId = await createProject(owner)
    const m1 = await db.createUser({ username: 'counted1', universityId })

    await db.asService(
      `insert into public.project_members (project_id, profile_id) values ($1, $2)`,
      [projectId, m1],
    )

    let rows = await db.asService<{ member_count: number }>(
      `select member_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.member_count).toBe(2)

    await db.asUser(
      m1,
      `delete from public.project_members where project_id = $1 and profile_id = $2`,
      [projectId, m1],
    )

    rows = await db.asService<{ member_count: number }>(
      `select member_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.member_count).toBe(1)
  })

  it('maintains star_count and refuses a forged star', async () => {
    const projectId = await createProject(owner)
    const fan = await db.createUser({ username: 'fan1', universityId })

    await db.asUser(
      fan,
      `insert into public.project_stars (project_id, profile_id) values ($1, $2)`,
      [projectId, fan],
    )

    const rows = await db.asService<{ star_count: number }>(
      `select star_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.star_count).toBe(1)

    // A star attributed to someone else would let one account inflate a count
    // that is meant to represent distinct people. profile_id is forced to the
    // caller, so the forged row collides with the star this user already cast
    // rather than being recorded against the victim.
    await expectRejection(
      () =>
        db.asUser(
          fan,
          `insert into public.project_stars (project_id, profile_id) values ($1, $2)`,
          [projectId, outsider],
        ),
      REJECTS.uniqueViolation,
    )

    const stars = await db.asService<{ profile_id: string }>(
      `select profile_id from public.project_stars where project_id = $1`,
      [projectId],
    )
    expect(stars).toHaveLength(1)
    expect(stars[0]!.profile_id).toBe(fan)
  })

  it('maintains the owner\'s project_count', async () => {
    const solo = await db.createUser({ username: 'solocounter', universityId })

    await createProject(solo)
    await createProject(solo, { title: 'Second Project' })

    const rows = await db.asService<{ project_count: number }>(
      `select project_count from public.profiles where id = $1`,
      [solo],
    )
    expect(rows[0]!.project_count).toBe(2)
  })
})

describe('project posts', () => {
  it('refuses a post anchored to a project the author is not a member of', async () => {
    // Otherwise the post would render the project's title and link wherever it
    // appears, leaking a project the author cannot see.
    const projectId = await createProject(owner, { visibility: 'private' })

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.posts (body, project_id, type)
           values ('Look at this project', $1, 'project_update')`,
          [projectId],
        ),
      /not_project_member|not a member|42501/i,
    )
  })

  it('allows a member to post an update and counts it', async () => {
    const projectId = await createProject(owner)

    await db.asUser(
      owner,
      `insert into public.posts (body, project_id, type)
       values ('Shipped the first milestone', $1, 'project_update')`,
      [projectId],
    )

    const rows = await db.asService<{ post_count: number }>(
      `select post_count from public.projects where id = $1`,
      [projectId],
    )
    expect(rows[0]!.post_count).toBe(1)
  })
})
