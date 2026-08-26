-- =============================================================================
-- supabase/tests/bootstrap.sql
--
-- ###########################################################################
-- ##  TEST HARNESS ONLY.  NEVER RUN THIS AGAINST A REAL SUPABASE PROJECT.  ##
-- ###########################################################################
--
-- A hosted Supabase project already provides everything in this file, and
-- running it there would at best fail and at worst clobber the real auth
-- schema. It is not in supabase/migrations/ precisely so that `supabase db
-- push` cannot pick it up.
--
-- WHY IT EXISTS
--
-- The migrations in supabase/migrations/ depend on platform objects that
-- Supabase creates before any user migration runs: the `anon`,
-- `authenticated` and `service_role` roles, the `auth` schema, `auth.uid()`,
-- and the `storage` tables. To test those migrations locally we need a
-- Postgres that has them.
--
-- Docker is not available in this environment, so the local database is PGlite
-- (real Postgres compiled to WebAssembly) rather than the Supabase CLI's
-- container. This file is the shim that makes a bare Postgres look enough like
-- Supabase for the migrations and their RLS policies to be exercised honestly.
--
-- WHAT IT DOES AND DOES NOT PROVE
--
--   Proves:        DDL applies in order; triggers and functions compile; RLS
--                  policies parse and filter correctly; column-level GRANTs
--                  block privilege escalation; constraints reject bad data.
--
--   Does not prove: GoTrue's real signup behaviour, Realtime replication,
--                  Storage's own access checks, or PostgREST's request
--                  handling. Those are verified against the hosted project.
--
-- Kept deliberately minimal: every object here is one the migrations actually
-- reference. A larger fake would drift from the real platform unnoticed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles.
--
-- `service_role` gets BYPASSRLS to match the platform, which is exactly why the
-- service-role key must never reach the browser: it is not merely privileged,
-- it is unfiltered.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end
$$;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- auth schema
-- -----------------------------------------------------------------------------
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

-- Only the columns the migrations actually touch. Supabase's real table has
-- roughly forty; copying all of them would be a fake that rots.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_anonymous       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null default '{}'::jsonb,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz not null default now(),
  primary key (provider, provider_id)
);

-- auth.uid() as Supabase defines it: read the `sub` claim out of the request
-- GUCs. Both spellings are supported because the platform has used both, and a
-- shim that only handled one would let a bug through.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    current_user::text
  )
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

grant execute on function auth.uid()   to anon, authenticated, service_role;
grant execute on function auth.role()  to anon, authenticated, service_role;
grant execute on function auth.email() to anon, authenticated, service_role;
grant execute on function auth.jwt()   to anon, authenticated, service_role;

-- Client roles must not be able to read the users table directly. On the real
-- platform they cannot; asserting it here keeps the shim honest, because a test
-- that passes only because the harness is permissive is worse than no test.
revoke all on table auth.users      from anon, authenticated;
revoke all on table auth.identities from anon, authenticated;
grant select on table auth.users to service_role;


-- -----------------------------------------------------------------------------
-- storage schema
--
-- Enough of it for the storage-policy migration to apply and be tested. The
-- real implementation adds triggers and helper functions that are not needed to
-- verify who is allowed to read or write which object path.
-- -----------------------------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null unique,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id             uuid primary key default gen_random_uuid(),
  bucket_id      text references storage.buckets (id),
  name           text,
  owner          uuid,
  metadata       jsonb,
  path_tokens    text[] generated always as (string_to_array(name, '/')) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_accessed_at timestamptz not null default now()
);

create unique index if not exists storage_objects_bucket_name_key
  on storage.objects (bucket_id, name);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- storage.foldername('a/b/c.png') -> {a,b}: the path segments without the
-- filename. Storage policies use it to check ownership of the first segment.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text)
returns text
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[array_length(parts, 1)];
end
$$;

create or replace function storage.extension(name text)
returns text
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(storage.filename(name), '.');
  return lower(parts[array_length(parts, 1)]);
end
$$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;
grant execute on function storage.filename(text)   to anon, authenticated, service_role;
grant execute on function storage.extension(text)  to anon, authenticated, service_role;

grant select on table storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on table storage.objects
  to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- Default privileges.
--
-- Supabase grants client roles broad table privileges by default and relies on
-- RLS to restrict rows. Our migrations deliberately REVOKE that and re-grant
-- per column. Replicating the permissive default here means the tests prove our
-- revokes work, rather than passing because nothing was granted to begin with.
-- -----------------------------------------------------------------------------
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
