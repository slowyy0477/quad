-- =============================================================================
-- 0002  Roles and privileges
-- =============================================================================
-- Roles live in their OWN table, deliberately not as a column on `profiles`.
--
-- Reason: users must be able to UPDATE their own profile row. Any policy that
-- permits that also permits writing every column of it. If `role` lived on
-- `profiles`, `update profiles set role = 'admin' where id = auth.uid()` would
-- be a one-line privilege escalation that passes RLS.
--
-- `user_roles` has no INSERT/UPDATE/DELETE grant for client roles at all. Roles
-- are assigned only by the service role, via `scripts/create-admin.ts` or the
-- admin module's server-side actions.
-- =============================================================================

create table public.user_roles (
  user_id     uuid    not null references auth.users (id) on delete cascade,
  role        text    not null check (role in ('admin', 'moderator')),
  granted_by  uuid             references auth.users (id) on delete set null,
  granted_at  timestamptz not null default now(),
  note        text,
  primary key (user_id, role)
);

comment on table public.user_roles is
  'Elevated privileges. Writable only by service_role. Never merge into profiles.';

create index user_roles_role_idx on public.user_roles (role);

alter table public.user_roles enable row level security;

-- Clients may read their own roles (the UI needs to know whether to show /admin)
-- and admins may read all of them. Nobody may write.
create policy user_roles_select_self
  on public.user_roles for select
  to authenticated
  using (user_id = auth.uid());

-- Table-level privileges: read only. No INSERT/UPDATE/DELETE reaches the table
-- even if a permissive policy is added by mistake later.
revoke all on table public.user_roles from anon, authenticated;
grant select on table public.user_roles to authenticated;


-- -----------------------------------------------------------------------------
-- Role predicates
--
-- `security definer` so they can read `user_roles` regardless of the caller's
-- RLS view of it. Without this, `app.is_admin()` used inside another table's
-- policy would only see the caller's own rows — which happens to work, but
-- breaks the moment we need "is this OTHER user an admin".
-- -----------------------------------------------------------------------------
create or replace function app.has_role(v_role text, v_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1 from public.user_roles ur
       where ur.user_id = v_user and ur.role = v_role
     );
$$;

create or replace function app.is_admin(v_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_role('admin', v_user);
$$;

-- Moderator-or-above. Admins implicitly hold every moderator capability.
create or replace function app.is_moderator(v_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1 from public.user_roles ur
       where ur.user_id = v_user and ur.role in ('admin', 'moderator')
     );
$$;

revoke execute on function app.has_role(text, uuid)  from public;
revoke execute on function app.is_admin(uuid)        from public;
revoke execute on function app.is_moderator(uuid)    from public;

grant execute on function app.has_role(text, uuid)   to authenticated, service_role;
grant execute on function app.is_admin(uuid)         to authenticated, service_role;
-- is_moderator is additionally granted to anon, which looks wrong and is not.
-- Several read policies are declared `to anon, authenticated` and are written as
--   author_id = auth.uid() or app.is_moderator() or (<visibility rules>)
-- RLS policy expressions are evaluated with the privileges of the CALLING role,
-- and SQL does not promise left-to-right short-circuiting of OR. So without this
-- grant an anonymous request to read the public feed fails outright with
-- "permission denied for function is_moderator" rather than simply seeing fewer
-- rows -- and it fails on every row, not just moderated ones.
--
-- The body returns false when v_user is null, and auth.uid() is null for anon,
-- so the grant cannot make an anonymous visitor a moderator. Nor is the function
-- callable from the API: PostgREST serves only `public` and `graphql_public`, so
-- nothing in `app` is reachable over HTTP. has_role and is_admin are NOT granted
-- to anon, because no anon-visible policy references them.
grant execute on function app.is_moderator(uuid)     to authenticated, anon, service_role;

-- Admins can read every role row (added after the predicate exists).
create policy user_roles_select_admin
  on public.user_roles for select
  to authenticated
  using (app.is_admin());

-- Belt and braces: block writes at the trigger level too.
create trigger user_roles_no_client_write
  before insert or update or delete on public.user_roles
  for each row execute function app.forbid_write();
