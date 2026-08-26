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

describe('function execute privileges', () => {
  /**
   * The other direction from the block above, and the reason 0015 exists.
   *
   * `revoke execute on function f() from public` is the idiom you reach for after
   * learning that PostgreSQL grants EXECUTE on a new function to PUBLIC by
   * default. It is necessary and it is not sufficient: Supabase also sets
   *
   *     alter default privileges in schema public
   *       grant execute on functions to anon, authenticated, service_role;
   *
   * and revoking from PUBLIC does not touch a grant made directly to a role. Ten
   * functions were written with the insufficient form before this was noticed;
   * one of them, dispatch_due_reminders(), was service-role-only by intent and
   * callable by every signed-in user.
   *
   * The migrations apply cleanly either way, and a permission test written per
   * function only catches the functions someone thought to write a test for. So
   * these two tests enumerate the catalog instead.
   */

  /** Functions in `public` that a signed-in user is meant to be able to call. */
  const CLIENT_RPCS = [
    'convert_idea_to_project',
    'create_group_conversation',
    'current_study_streak',
    'mark_conversation_read',
    'start_direct_conversation',
    'total_unread_messages',
    'touch_last_active',
    'transfer_project_ownership',
    'unread_notification_count',
  ]

  /** Functions in `public` that no client may call, at all. */
  const SERVICE_ONLY = ['dispatch_due_reminders']

  it('exposes no app helper to a client unless a policy or constraint needs it', async () => {
    // `security invoker` helpers are exempt by design: app.is_trusted_write()
    // reads pg_trigger_depth() and a session GUC, so it has to be evaluated in
    // the caller's own context, which means the caller needs EXECUTE. Running as
    // the invoker is all it does, so it cannot be used to reach anything the
    // caller could not reach directly.
    const rows = await db.asService<{ proname: string; role_name: string }>(`
      with referenced as (
        select coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
          from pg_policy p
        union all
        select pg_get_constraintdef(c.oid) from pg_constraint c where c.contype = 'c'
      ),
      fn as (
        select pr.oid, pr.proname, pr.proname || '(' as needle
          from pg_proc pr
          join pg_namespace n on n.oid = pr.pronamespace
         where n.nspname = 'app'
           and pr.prosecdef
      )
      select fn.proname, role_name
        from fn
        cross join unnest(array['anon', 'authenticated']) as role_name
       where has_function_privilege(role_name, fn.oid, 'EXECUTE')
         and not exists (
           select 1 from referenced r where position(fn.needle in r.expr) > 0
         )
       order by 1, 2
    `)

    expect(rows.map((r) => `${r.role_name} -> app.${r.proname}()`)).toEqual([])
  })

  it('lets no anonymous visitor call any function in public', async () => {
    // Every RPC here derives its caller from auth.uid(), which is null for an
    // anonymous request. There is no correct thing for any of them to do on an
    // anonymous caller's behalf, and several raise distinguishable errors
    // depending on whether a row exists -- which makes an anonymous EXECUTE an
    // enumeration oracle for rows the caller cannot read.
    const rows = await db.asService<{ signature: string }>(`
      select p.oid::regprocedure::text as signature
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (
           select 1 from pg_depend d
            where d.objid = p.oid and d.deptype = 'e'
         )
         and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by 1
    `)
    expect(rows.map((r) => r.signature)).toEqual([])
  })

  it('sorts every function in public into exactly one intended audience', async () => {
    // A new function in `public` fails this test until someone puts its name in
    // one of the two lists above. That is the point: the decision about who may
    // call it is made deliberately rather than inherited from a default grant.
    const rows = await db.asService<{ proname: string; authenticated: boolean }>(`
      select p.proname,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (
           select 1 from pg_depend d
            where d.objid = p.oid and d.deptype = 'e'
         )
       order by 1
    `)

    const unaccounted = rows
      .map((r) => r.proname)
      .filter((name) => !CLIENT_RPCS.includes(name) && !SERVICE_ONLY.includes(name))
    expect(unaccounted).toEqual([])

    // Non-vacuity. If the extension filter ever excluded everything, the two
    // assertions below would both pass against an empty set.
    expect(rows).toHaveLength(CLIENT_RPCS.length + SERVICE_ONLY.length)

    const wrongAudience = rows
      .filter((r) => r.authenticated !== CLIENT_RPCS.includes(r.proname))
      .map((r) => `${r.proname}: authenticated=${r.authenticated}`)
    expect(wrongAudience).toEqual([])
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
