/**
 * Cross-cutting guard semantics.
 *
 * Two helpers in `app` are relied on by almost every table in the schema:
 *
 *   app.is_privileged_role()             -- "is this a client request?"
 *   app.reject_protected_column_change() -- "is this column client-writable?"
 *
 * Both were originally implemented with a test on `current_user`, and both were
 * wrong in the same way: inside a SECURITY DEFINER function -- which is where
 * essentially every guard in this schema lives -- current_user is the function
 * OWNER, not the caller. The result was that every guard reported ordinary users
 * as privileged and skipped itself.
 *
 * That failure was invisible in a schema smoke test, because the migrations
 * still applied cleanly. It only surfaced once a test actually inserted a row as
 * a real user. These tests pin the corrected behaviour so it cannot regress
 * quietly again.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let user: string

beforeAll(async () => {
  db = await createTestDb()
  user = await db.createUser({ username: 'guarded' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('app.is_privileged_role', () => {
  it('is false for an authenticated user', async () => {
    const rows = await db.asUser<{ p: boolean }>(
      user,
      `select app.is_privileged_role() as p`,
    )
    expect(rows[0]!.p).toBe(false)
  })

  it('is false for an anonymous visitor', async () => {
    const rows = await db.asAnon<{ p: boolean }>(`select app.is_privileged_role() as p`)
    expect(rows[0]!.p).toBe(false)
  })

  it('is true for a direct/service connection', async () => {
    const rows = await db.asService<{ p: boolean }>(`select app.is_privileged_role() as p`)
    expect(rows[0]!.p).toBe(true)
  })

  it('stays false inside a SECURITY DEFINER function called by a user', async () => {
    // The regression that made every guard in the schema a no-op. A
    // current_user-based implementation returns TRUE here, because current_user
    // is the function owner rather than the caller.
    await db.asService(`
      create or replace function public.probe_privileged()
      returns boolean language sql stable security definer set search_path = ''
      as $fn$ select app.is_privileged_role(); $fn$
    `)
    await db.asService(`grant execute on function public.probe_privileged() to authenticated`)

    const rows = await db.asUser<{ p: boolean }>(user, `select public.probe_privileged() as p`)
    expect(rows[0]!.p).toBe(false)
  })

  it('fails closed when only one of the two signals looks privileged', async () => {
    // The JWT claim says `authenticated` while the role GUC is reset. Requiring
    // both signals to agree means a mismatch never grants the bypass.
    await db.raw.exec('reset role;')
    await db.raw.query('select set_config($1, $2, false)', [
      'request.jwt.claims',
      JSON.stringify({ sub: user, role: 'authenticated' }),
    ])
    const rows = await db.raw.query<{ p: boolean }>(`select app.is_privileged_role() as p`)
    expect(rows.rows[0]!.p).toBe(false)

    // Leave the session clean for the next test.
    await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', ''])
  })
})

describe('app.reject_protected_column_change', () => {
  it('refuses a client write to a protected column', async () => {
    // profiles.follower_count is trigger-maintained. Letting a client set it
    // would make every follower number on the site a claim rather than a fact.
    await expectRejection(
      () =>
        db.asUser(
          user,
          `update public.profiles set follower_count = 9999 where id = $1`,
          [user],
        ),
      // The column-level GRANT refuses first; the trigger is the second layer.
      /permission denied|cannot be modified/i,
    )
  })

  it('allows the schema\'s own triggers to maintain those columns', async () => {
    // The guard exempts writes at pg_trigger_depth() > 1 rather than writes by a
    // privileged role, because the maintaining triggers are SECURITY DEFINER and
    // are deliberately *not* privileged.
    const other = await db.createUser({ username: 'followed' })

    await db.asUser(user, `insert into public.follows (follower_id, following_id) values ($1, $2)`, [
      user,
      other,
    ])

    const rows = await db.asService<{ follower_count: number }>(
      `select follower_count from public.profiles where id = $1`,
      [other],
    )
    expect(rows[0]!.follower_count).toBe(1)
  })

  it('still refuses a client write when the column grant is mistakenly widened', async () => {
    // The whole point of keeping the trigger as a second layer: a future
    // `grant update` added by accident must not immediately become a
    // privilege-escalation bug.
    await db.asService(`grant update (follower_count) on table public.profiles to authenticated`)

    try {
      await expectRejection(
        () =>
          db.asUser(
            user,
            `update public.profiles set follower_count = 9999 where id = $1`,
            [user],
          ),
        /cannot be modified/i,
      )
    } finally {
      await db.asService(
        `revoke update (follower_count) on table public.profiles from authenticated`,
      )
    }
  })
})

describe('role table', () => {
  it('does not let a user grant themselves a role', async () => {
    // Roles live in their own table rather than a profiles column precisely so
    // that "update my own profile" can never be "make myself an admin".
    await expectRejection(
      () =>
        db.asUser(
          user,
          `insert into public.user_roles (user_id, role) values ($1, 'admin')`,
          [user],
        ),
      /permission denied|row-level security/i,
    )

    const rows = await db.asUser<{ n: number }>(
      user,
      `select count(*)::int as n from public.user_roles where user_id = $1`,
      [user],
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('reports admin status from the roles table', async () => {
    const admin = await db.createUser({ username: 'realadmin', role: 'admin' })

    const rows = await db.asUser<{ is_admin: boolean }>(
      admin,
      `select app.is_admin() as is_admin`,
    )
    expect(rows[0]!.is_admin).toBe(true)

    const notAdmin = await db.asUser<{ is_admin: boolean }>(
      user,
      `select app.is_admin() as is_admin`,
    )
    expect(notAdmin[0]!.is_admin).toBe(false)
  })

  it('keeps the roles table append-only for clients', async () => {
    const admin = await db.createUser({ username: 'realadmin2', role: 'admin' })

    await expectRejection(
      () => db.asUser(admin, `delete from public.user_roles where user_id = $1`, [admin]),
      /permission denied|not permitted|42501|row-level security/i,
    )
  })
})

describe('username uniqueness under concurrency', () => {
  it('lets exactly one of two simultaneous claims succeed', async () => {
    // The specification is explicit that frontend validation cannot be the
    // guarantee here. Two users race for the same handle; the unique index on
    // lower(username) decides.
    const a = await db.createUser()
    const b = await db.createUser()

    await db.asUser(a, `update public.profiles set username = 'contested' where id = $1`, [a])

    await expectRejection(
      () => db.asUser(b, `update public.profiles set username = 'Contested' where id = $1`, [b]),
      REJECTS.uniqueViolation,
    )

    const rows = await db.asService<{ id: string }>(
      `select id from public.profiles where lower(username) = 'contested'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(a)
  })

  it('refuses a reserved username', async () => {
    const c = await db.createUser()
    await expectRejection(
      () => db.asUser(c, `update public.profiles set username = 'admin' where id = $1`, [c]),
      /reserved|not permitted|42501/i,
    )
  })
})
