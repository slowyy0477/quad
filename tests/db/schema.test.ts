/**
 * Schema smoke test.
 *
 * The single most valuable database test: it proves every migration applies to a
 * clean Postgres in filename order. Forward references, missing helper
 * functions, wrong argument signatures and typos in policy expressions all
 * surface here rather than during a production deploy.
 *
 * It also asserts the invariants that must hold for the whole security model to
 * mean anything -- notably that RLS is enabled on every public table. An
 * unprotected table is not a small bug; with Supabase it is a public API.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './harness'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('migrations', () => {
  it('applies every migration to a clean database', async () => {
    const rows = await db.asService<{ count: number }>(
      `select count(*)::int as count from pg_tables where schemaname = 'public'`,
    )
    expect(rows[0]!.count).toBeGreaterThan(0)
  })

  it('does not expose the app helper schema through PostgREST', async () => {
    // PostgREST only exposes schemas listed in its config; `app` is not one.
    // The defence in depth here is that `app` functions are not granted to
    // client roles unless they are needed as RLS predicates.
    const rows = await db.asService<{ nspname: string }>(
      `select nspname from pg_namespace where nspname = 'app'`,
    )
    expect(rows).toHaveLength(1)
  })
})

describe('row level security', () => {
  it('is enabled on every table in the public schema', async () => {
    const rows = await db.asService<{ tablename: string }>(
      `select c.relname as tablename
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not c.relrowsecurity
        order by 1`,
    )
    expect(rows.map((r) => r.tablename)).toEqual([])
  })

  it('has at least one policy on every table with RLS enabled', async () => {
    // RLS with no policies denies everything, which is safe but is almost always
    // an oversight rather than a decision. Flag it either way.
    const rows = await db.asService<{ tablename: string }>(
      `select c.relname as tablename
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relrowsecurity
          and not exists (
            select 1 from pg_policy p where p.polrelid = c.oid
          )
        order by 1`,
    )
    expect(rows.map((r) => r.tablename)).toEqual([])
  })
})

describe('function hardening', () => {
  it('pins search_path on every function in the app schema', async () => {
    // A SECURITY DEFINER function without a pinned search_path can be hijacked
    // by a caller who creates a same-named object in a schema they control.
    const rows = await db.asService<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
             where cfg like 'search_path=%'
          )
        order by 1`,
    )
    expect(rows.map((r) => r.proname)).toEqual([])
  })

  it('pins search_path on every security definer function in public', async () => {
    const rows = await db.asService<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
             where cfg like 'search_path=%'
          )
        order by 1`,
    )
    expect(rows.map((r) => r.proname)).toEqual([])
  })
})

describe('policy execute privileges', () => {
  /**
   * Every `app` function named in a policy expression, cross-joined with every
   * role that policy applies to.
   *
   * This exists because of a failure mode that is invisible in every other test
   * here. RLS policy expressions are evaluated with the privileges of the
   * CALLING role, so a policy declared `to anon, authenticated` that calls a
   * helper granted only to `authenticated` does not quietly return fewer rows --
   * it raises "permission denied for function ..." and fails the entire SELECT.
   * And because SQL does not promise left-to-right short-circuiting of OR, the
   * failure does not even require the guarded branch to be relevant: one
   * university-scoped row in the table is enough to break anonymous browsing of
   * the whole feed.
   *
   * The migrations apply cleanly either way -- GRANTs are not validated against
   * policy bodies -- so nothing catches this except reading every policy, which
   * is what the query below does.
   */
  const GAPS_SQL = `
    with pol as (
      select c.relname as tablename,
             p.polname,
             case
               when p.polroles = '{0}'::oid[] then array['public']
               else array(select r.rolname::text from pg_roles r
                           where r.oid = any(p.polroles))
             end as roles,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
    ),
    fn as (
      -- Matched on the bare name rather than "app.name(" so the assertion does
      -- not depend on how pg_get_expr chooses to schema-qualify the call.
      select pr.oid, pr.proname, pr.proname || '(' as needle
        from pg_proc pr
        join pg_namespace n on n.oid = pr.pronamespace
       where n.nspname = 'app'
    )
    select pol.tablename, pol.polname, role_name, fn.proname
      from pol
      cross join unnest(pol.roles) as role_name
      join fn on position(fn.needle in pol.expr) > 0
     where role_name <> 'service_role'
       and not has_function_privilege(role_name, fn.oid, 'EXECUTE')
     order by 1, 2, 3, 4
  `

  it('grants EXECUTE on every helper a policy calls, to every role it applies to', async () => {
    const rows = await db.asService<{
      tablename: string
      polname: string
      role_name: string
      proname: string
    }>(GAPS_SQL)

    expect(
      rows.map((r) => `${r.tablename}.${r.polname}: ${r.role_name} -> app.${r.proname}()`),
    ).toEqual([])
  })

  it('actually matches policy expressions to functions', async () => {
    // Guards the test above against passing vacuously. If pg_get_expr ever
    // renders calls in a form the needle does not match, the gap query returns
    // zero rows for the wrong reason and the check silently stops working.
    const rows = await db.asService<{ pairs: number }>(`
      with pol as (
        select coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
      ),
      fn as (
        select pr.proname || '(' as needle
          from pg_proc pr
          join pg_namespace n on n.oid = pr.pronamespace
         where n.nspname = 'app'
      )
      select count(*)::int as pairs
        from pol join fn on position(fn.needle in pol.expr) > 0
    `)
    expect(rows[0]!.pairs).toBeGreaterThan(20)
  })
})

describe('signup', () => {
  it('creates a profile row via the auth.users trigger', async () => {
    const userId = await db.createUser({ fullName: 'Ada Lovelace' })

    const rows = await db.asService<{
      id: string
      username: string
      display_name: string
      onboarding_completed: boolean
    }>(
      `select id, username, display_name, onboarding_completed
         from public.profiles where id = $1`,
      [userId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.display_name).toBe('Ada Lovelace')
    // A placeholder handle derived from the uuid, so signup never races on
    // username uniqueness. The real handle is chosen during onboarding.
    expect(rows[0]!.username).toMatch(/^u[0-9a-f]{12}$/)
    expect(rows[0]!.onboarding_completed).toBe(false)
  })

  it('enforces case-insensitive username uniqueness', async () => {
    const a = await db.createUser({ username: 'takenhandle' })
    expect(a).toBeTruthy()

    const b = await db.createUser()
    // Frontend validation cannot guarantee this; the unique index can.
    await expect(
      db.asService(`update public.profiles set username = 'TakenHandle' where id = $1`, [b]),
    ).rejects.toThrow(/duplicate key value|unique/i)
  })
})
