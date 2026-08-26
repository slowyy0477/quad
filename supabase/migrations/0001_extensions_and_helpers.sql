-- =============================================================================
-- 0001  Extensions, the `app` schema, and generic helpers
-- =============================================================================
-- Everything security-sensitive lives in the `app` schema, never in `public`.
--
-- Two facts drive the grant strategy in this file:
--
--   1. RLS policy expressions are evaluated with the privileges of the CALLING
--      role. So `authenticated` must have USAGE on `app` and EXECUTE on any
--      function a policy references. Locking the schema away entirely would
--      make every policy fail with "permission denied for schema app".
--
--   2. Postgres grants EXECUTE on new functions to PUBLIC by default. Every
--      function below is therefore explicitly REVOKEd from public and then
--      granted only to the roles that need it.
--
-- Exposing these functions to `authenticated` is safe because PostgREST only
-- serves schemas in its `db-schemas` config (`public`, `graphql_public`).
-- Nothing in `app` is reachable over the REST/RPC API.
--
-- Trigger functions are NOT granted to clients: Postgres does not check EXECUTE
-- privilege when a trigger fires, only when the trigger is created.
--
-- Every function is `set search_path = ''` with fully-qualified names. Without
-- that, a `security definer` function can be hijacked by a caller who controls
-- their own search_path.
-- =============================================================================

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- Extensions go in `extensions` (Supabase convention), never in public.
create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gin with schema extensions;
-- gen_random_uuid() is core Postgres from v13; pgcrypto is not required.


-- -----------------------------------------------------------------------------
-- app.set_updated_at()  — attach to every table that has updated_at
-- -----------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function app.set_updated_at() from public;


-- -----------------------------------------------------------------------------
-- app.slugify(text) — deterministic, ASCII-safe, immutable (so it can be indexed)
-- -----------------------------------------------------------------------------
create or replace function app.slugify(v_input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(lower(coalesce(v_input, '')), '[^a-z0-9]+', '-', 'g')
    ),
    ''
  );
$$;

revoke execute on function app.slugify(text) from public;
grant execute on function app.slugify(text) to authenticated, anon, service_role;


-- -----------------------------------------------------------------------------
-- app.unique_slug(table, column, base) — appends -2, -3, ... until free.
--
-- Slugs are assigned by BEFORE INSERT triggers, never supplied by the client:
-- a client-chosen slug is both a race condition and an enumeration vector.
-- -----------------------------------------------------------------------------
create or replace function app.unique_slug(
  v_table text,
  v_column text,
  v_base text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug   text;
  v_try    text;
  v_n      int := 1;
  v_exists boolean;
begin
  v_slug := left(coalesce(app.slugify(v_base), 'item'), 60);
  v_try  := v_slug;

  loop
    execute format(
      'select exists (select 1 from public.%I where %I = $1)',
      v_table, v_column
    ) into v_exists using v_try;

    exit when not v_exists;

    v_n := v_n + 1;
    v_try := left(v_slug, 55) || '-' || v_n::text;

    if v_n > 500 then
      -- Pathological contention: use a random suffix rather than spinning.
      v_try := left(v_slug, 50) || '-'
               || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
      exit;
    end if;
  end loop;

  return v_try;
end;
$$;

revoke execute on function app.unique_slug(text, text, text) from public;


-- -----------------------------------------------------------------------------
-- app.is_privileged_role() — true for the roles that legitimately bypass the
-- client-facing guards (migrations, server-side admin operations, Auth hooks).
-- -----------------------------------------------------------------------------
create or replace function app.is_privileged_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in (
    'postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin'
  );
$$;

revoke execute on function app.is_privileged_role() from public;
grant execute on function app.is_privileged_role() to authenticated, anon, service_role;


-- -----------------------------------------------------------------------------
-- app.reject_protected_column_change(col, ...)
--
-- Makes specific columns immutable from client roles even though the row itself
-- is updatable. Column-level GRANTs are the primary defence; this trigger is
-- the second layer, so a future mistaken `grant update` is not instantly a
-- privilege-escalation bug.
--
-- Usage:
--   create trigger x before update on public.t for each row
--     execute function app.reject_protected_column_change('status', 'role');
-- -----------------------------------------------------------------------------
create or replace function app.reject_protected_column_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_col text;
  v_old text;
  v_new text;
begin
  if app.is_privileged_role() then
    return new;
  end if;

  foreach v_col in array tg_argv loop
    execute format('select ($1).%I::text, ($2).%I::text', v_col, v_col)
      into v_old, v_new using old, new;

    if v_old is distinct from v_new then
      raise exception
        'column "%" of table "%" cannot be modified by role "%"',
        v_col, tg_table_name, current_user
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function app.reject_protected_column_change() from public;


-- -----------------------------------------------------------------------------
-- app.forbid_write() — attach to append-only tables (audit log) to block
-- UPDATE/DELETE from every role except the privileged ones.
-- -----------------------------------------------------------------------------
create or replace function app.forbid_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if app.is_privileged_role() then
    return coalesce(new, old);
  end if;
  raise exception '% on table "%" is not permitted', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;

revoke execute on function app.forbid_write() from public;


-- =============================================================================
-- Visibility algebra
--
-- Four visibility levels form a total order, so "no more visible than" is just
-- a comparison. Both functions live here rather than next to the first table
-- that uses them because profiles, posts and projects all need them and the
-- rule must be identical for all three -- three separate CASE expressions
-- would drift.
--
-- The invariant they exist to enforce: a piece of content can never be more
-- visible than the profile that authored it. Otherwise an anonymous visitor
-- could read a public post by an author whose name they are not permitted to
-- see, and the row-level privacy model would contradict itself.
-- =============================================================================

create or replace function app.visibility_rank(v_visibility text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case v_visibility
           when 'public'      then 3
           when 'university'  then 2
           when 'connections' then 1
           else 0                        -- 'private', and anything unrecognised
         end;
$$;

create or replace function app.clamp_visibility(v_requested text, v_ceiling text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when app.visibility_rank(v_requested) <= app.visibility_rank(v_ceiling)
      then v_requested
    else v_ceiling
  end;
$$;

comment on function app.clamp_visibility(text, text) is
  'Returns the less visible of the two levels. Used in BEFORE triggers so the
   ceiling holds regardless of which code path writes the row.';

revoke execute on function app.visibility_rank(text)        from public;
revoke execute on function app.clamp_visibility(text, text) from public;
grant execute on function app.visibility_rank(text)         to authenticated, service_role;
grant execute on function app.clamp_visibility(text, text)  to authenticated, service_role;


comment on schema app is
  'Private schema for security-definer helpers and RLS predicates. Not exposed via PostgREST.';
