-- =============================================================================
-- 0015 — Function grants
--
-- A correction, and the reason for it.
--
-- Every restricted function in migrations 0004 to 0013 ends with the line
--
--     revoke execute on function public.some_function(...) from public;
--
-- which is the idiom you reach for after reading that PostgreSQL grants EXECUTE
-- on a new function to PUBLIC by default. That is true, and revoking it is
-- necessary -- but on Supabase it is not sufficient. Supabase also configures
--
--     alter default privileges in schema public
--       grant execute on functions to anon, authenticated, service_role;
--
-- so a new function in `public` arrives with EXECUTE granted *directly* to three
-- named roles as well as to PUBLIC. Revoking from PUBLIC does not touch a direct
-- grant to a role, so the function stays callable by anyone with an API key.
--
-- The consequence was mild for most of these functions and serious for one.
-- Nine of them are security definer wrappers that derive the caller from
-- auth.uid(), which is null for an anonymous request, so an anonymous call
-- mostly did nothing -- but "mostly did nothing" is not an access control
-- decision, and several of them raise distinguishable errors depending on
-- whether a row exists, which makes them enumeration oracles for objects the
-- caller cannot read. public.dispatch_due_reminders() in 0014 was the sharp
-- case: it is service-role-only by intent and was callable by every signed-in
-- user, who could have used its return value to count notifications generated
-- for other people.
--
-- The rule, from here on, stated once so it need not be rediscovered:
--
--     A function's grant block names every role it revokes from. It does not
--     rely on `from public` to remove a grant that was made to a role.
--
-- The invariant test in tests/db/schema.test.ts enumerates every function in
-- `public` and `app` and fails if one is executable by a role that is not on its
-- allow-list, so a future migration cannot reintroduce this quietly.
--
-- Functions in the `app` schema were never affected: `app` is not covered by
-- Supabase's default privileges, so the only grant those functions ever had was
-- the implicit one to PUBLIC, which `revoke ... from public` does remove. They
-- are re-revoked below anyway, because an invariant that is enforced in one
-- place and assumed in another is not an invariant.
-- =============================================================================


-- =============================================================================
-- Client-callable RPCs.
--
-- These are the functions a signed-in user is meant to call. They stay granted
-- to `authenticated`; the correction is that `anon` loses the EXECUTE it was
-- given by default. An anonymous visitor has no identity, so there is no
-- sensible thing for any of them to do on their behalf.
-- =============================================================================

revoke execute on function public.touch_last_active() from public, anon;
grant execute on function public.touch_last_active() to authenticated;

revoke execute on function public.transfer_project_ownership(uuid, uuid)
  from public, anon;
grant execute on function public.transfer_project_ownership(uuid, uuid)
  to authenticated;

revoke execute on function public.convert_idea_to_project(uuid) from public, anon;
grant execute on function public.convert_idea_to_project(uuid) to authenticated;

revoke execute on function public.start_direct_conversation(uuid) from public, anon;
grant execute on function public.start_direct_conversation(uuid) to authenticated;

revoke execute on function public.create_group_conversation(text, uuid[])
  from public, anon;
grant execute on function public.create_group_conversation(text, uuid[])
  to authenticated;

revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

revoke execute on function public.total_unread_messages() from public, anon;
grant execute on function public.total_unread_messages() to authenticated;

revoke execute on function public.current_study_streak() from public, anon;
grant execute on function public.current_study_streak() to authenticated;

revoke execute on function public.unread_notification_count() from public, anon;
grant execute on function public.unread_notification_count() to authenticated;


-- =============================================================================
-- Service-role-only functions.
--
-- Nothing a client may call. Named separately from the block above so that the
-- distinction is visible in the file rather than inferred from the grant lines.
-- =============================================================================

revoke execute on function public.dispatch_due_reminders(interval, interval)
  from public, anon, authenticated;
grant execute on function public.dispatch_due_reminders(interval, interval)
  to service_role;


-- =============================================================================
-- The `app` schema.
--
-- Belt and braces, as described in the header. `revoke all on schema app from
-- public` in 0001 does not help here: 0001 also grants USAGE on the schema to
-- the client roles, because RLS policies are evaluated with the privileges of
-- the calling role and a policy that calls app.is_admin() needs the caller to
-- reach it. USAGE on the schema plus EXECUTE on a function is all it takes, so
-- each function must revoke for itself.
--
-- This is deliberately derived rather than listed. A hand-written list would be
-- wrong the moment a later migration adds a function, and there are two ways for
-- it to be wrong: name a function that should be private and it stays callable
-- by anyone, or omit one a policy depends on and every query against that table
-- fails. So both halves are computed from the catalog.
--
-- Step one: revoke EXECUTE on every function in `app` from all three client
-- roles and from PUBLIC -- except the security *invoker* ones.
--
-- The exception is not a special case, it is the definition. A helper in `app`
-- that is deliberately not `security definer` exists precisely so that it is
-- evaluated in the caller's own context: app.is_trusted_write() reads
-- pg_trigger_depth() and a session GUC, and both answers would be wrong if the
-- function ran as its owner. A function like that has to be callable by the
-- client, and it cannot be used to escalate anything, because running as the
-- invoker is the whole of what it does -- any table it touched would be filtered
-- by the caller's own RLS.
-- =============================================================================

do $$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon, authenticated',
                   v_fn.signature);
  end loop;
end;
$$;


-- =============================================================================
-- Step two: put back exactly what the policies need, and nothing else.
--
-- A policy's expression runs as the calling role, so every `app.` function named
-- in a USING or WITH CHECK clause has to be executable by the roles that policy
-- applies to. Revoking EXECUTE on one of those secures nothing -- it breaks every
-- query against the table, which is a louder failure than a security hole but a
-- failure all the same.
--
-- So: read the policy expressions out of the catalog, find the app functions they
-- mention, and grant each one to the union of the roles of the policies that
-- mention it. A function reached only from *inside* another app function is not
-- matched and does not need to be: those callers are security definer, so the
-- inner call runs with the definer's privileges, not the client's.
--
-- Check constraints get the same treatment against `authenticated` only. They
-- are evaluated in the writing session, and no client role other than
-- `authenticated` may write to any table here.
--
-- The regexp looks for `app.name(`, which is how pg_get_expr renders a call to a
-- function in a schema outside the search_path -- and `app` is outside it for
-- every role, by construction.
-- =============================================================================

do $$
declare
  v_ref   record;
  v_grant text;
begin
  for v_ref in
    with policy_refs as (
      select
        lower(m[1]) as fn_name,
        case
          when pol.polroles = '{0}'::oid[] then array['public']
          else (
            select array_agg(distinct quote_ident(r.rolname) order by quote_ident(r.rolname))
              from unnest(pol.polroles) as pr(oid)
              join pg_roles r on r.oid = pr.oid
          )
        end as roles
        from pg_policy pol
        cross join lateral regexp_matches(
          coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
          'app\.([a-z_]+)\s*\(', 'g'
        ) as m
    ),
    constraint_refs as (
      select lower(m[1]) as fn_name, array['authenticated'] as roles
        from pg_constraint con
        cross join lateral regexp_matches(
          pg_get_constraintdef(con.oid), 'app\.([a-z_]+)\s*\(', 'g'
        ) as m
       where con.contype = 'c'
    ),
    all_refs as (
      select * from policy_refs
      union all
      select * from constraint_refs
    )
    select
      p.oid::regprocedure as signature,
      array_agg(distinct role_name) as roles
      from all_refs r
      cross join lateral unnest(r.roles) as role_name
      join pg_proc p on p.proname = r.fn_name
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
     group by p.oid
  loop
    v_grant := format('grant execute on function %s to %s',
                      v_ref.signature, array_to_string(v_ref.roles, ', '));
    raise notice '%', v_grant;
    execute v_grant;
  end loop;
end;
$$;

