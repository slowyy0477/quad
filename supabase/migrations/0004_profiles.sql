-- =============================================================================
-- 0004  Profiles
-- =============================================================================
-- One row per auth user, created by a trigger on auth.users so that a profile
-- ALWAYS exists for an authenticated session. Nothing in the app has to handle
-- "logged in but no profile".
--
-- The username is assigned a collision-proof placeholder at signup (u<hex>) and
-- chosen properly during onboarding. This ordering matters: signup cannot fail
-- because a username was taken 3ms earlier.
--
-- PRIVACY MODEL
-- -------------
-- `visibility` is enforced at ROW level, not column level, and the row is the
-- unit of privacy. To keep that coherent, a non-public profile cannot author
-- public content: `posts`/`projects` visibility is clamped to the author's
-- profile visibility by trigger (see 0006/0007). Without that clamp you get the
-- contradiction of an anonymous visitor reading a public post whose author's
-- name they are not allowed to see.
--
-- PRIVILEGE ESCALATION
-- --------------------
-- `authenticated` is granted UPDATE on an explicit column list. It has no
-- UPDATE privilege on `status`, `suspended_until`, `username_changed_at`,
-- `deleted_at`, or any counter. Those are Postgres column privileges, checked
-- before RLS and independent of it — so a mistaken policy cannot open them.
-- There is no `role` column here at all; see 0002.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reserved usernames. A table, not a CHECK constraint, because CHECK cannot run
-- a subquery — and because moderators need to extend the list without a
-- migration.
-- -----------------------------------------------------------------------------
create table public.reserved_usernames (
  username text primary key check (username = lower(username)),
  reason   text not null default 'reserved'
);

alter table public.reserved_usernames enable row level security;

-- Readable so the signup form can explain *why* a name is unavailable.
create policy reserved_usernames_select
  on public.reserved_usernames for select
  to anon, authenticated using (true);

revoke all on table public.reserved_usernames from anon, authenticated;
grant select on table public.reserved_usernames to anon, authenticated;

insert into public.reserved_usernames (username, reason) values
  ('admin', 'impersonation'),      ('administrator', 'impersonation'),
  ('support', 'impersonation'),    ('help', 'impersonation'),
  ('moderator', 'impersonation'),  ('mod', 'impersonation'),
  ('system', 'impersonation'),     ('official', 'impersonation'),
  ('root', 'impersonation'),       ('staff', 'impersonation'),
  ('team', 'impersonation'),       ('security', 'impersonation'),
  ('billing', 'impersonation'),    ('noreply', 'impersonation'),
  ('no_reply', 'impersonation'),   ('postmaster', 'impersonation'),
  ('webmaster', 'impersonation'),  ('abuse', 'impersonation'),
  ('legal', 'impersonation'),      ('privacy', 'impersonation'),
  ('quad', 'brand'),               ('quadapp', 'brand'),
  -- Route collisions: these would shadow real pages.
  ('api', 'route'),                ('auth', 'route'),
  ('login', 'route'),              ('signup', 'route'),
  ('logout', 'route'),             ('onboarding', 'route'),
  ('settings', 'route'),           ('dashboard', 'route'),
  ('explore', 'route'),            ('search', 'route'),
  ('messages', 'route'),           ('notifications', 'route'),
  ('projects', 'route'),           ('project', 'route'),
  ('universities', 'route'),       ('university', 'route'),
  ('opportunities', 'route'),      ('events', 'route'),
  ('about', 'route'),              ('contact', 'route'),
  ('terms', 'route'),              ('guidelines', 'route'),
  ('sitemap', 'route'),            ('robots', 'route'),
  ('static', 'route'),             ('_next', 'route'),
  ('me', 'route'),                 ('new', 'route'),
  ('edit', 'route'),               ('null', 'route'),
  ('undefined', 'route'),          ('anonymous', 'route');


-- =============================================================================
-- profiles
-- =============================================================================

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,

  -- Stored with the case the user chose; uniqueness is case-insensitive via the
  -- lower() index below. Same semantics as GitHub.
  username      text not null
                check (username ~ '^[A-Za-z0-9][A-Za-z0-9_]{1,28}[A-Za-z0-9]$'),
  display_name  text not null check (length(btrim(display_name)) between 1 and 80),

  avatar_url    text,
  cover_url     text,
  headline      text check (length(headline) <= 120),
  bio           text check (length(bio) <= 1000),

  university_id uuid references public.universities (id) on delete set null,
  department_id uuid references public.departments  (id) on delete set null,
  program_id    uuid references public.programs     (id) on delete set null,
  degree        text check (length(degree) <= 160),
  semester      integer check (semester between 1 and 24),
  graduation_year integer check (graduation_year between 1950 and 2100),
  location      text check (length(location) <= 120),

  website          text check (website is null or website ~* '^https?://'),
  github_username  text check (github_username ~ '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$'),
  linkedin_url     text check (linkedin_url is null or linkedin_url ~* '^https?://([a-z]{2,3}\.)?linkedin\.com/'),
  twitter_username text check (twitter_username ~ '^[A-Za-z0-9_]{1,15}$'),

  -- Privacy (spec §33). See the header note on row-level enforcement.
  visibility text not null default 'public'
             check (visibility in ('public', 'university', 'connections', 'private')),
  allow_messages_from text not null default 'everyone'
             check (allow_messages_from in ('everyone', 'university', 'connections', 'nobody')),
  allow_connection_requests boolean not null default true,
  searchable  boolean not null default true,

  onboarding_completed boolean not null default false,
  onboarding_step      integer not null default 0 check (onboarding_step between 0 and 12),

  -- Moderation state. NOT granted to `authenticated`.
  status text not null default 'active'
         check (status in ('active', 'suspended', 'banned', 'deactivated')),
  suspended_until   timestamptz,
  suspension_reason text,
  warning_count     integer not null default 0,

  -- Rate-limits a username change to once per 30 days (checked by trigger).
  username_changed_at timestamptz,

  -- Denormalised counters, maintained by security-definer triggers.
  follower_count   integer not null default 0,
  following_count  integer not null default 0,
  connection_count integer not null default 0,
  post_count       integer not null default 0,
  project_count    integer not null default 0,

  last_active_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint profiles_suspension_coherent
    check (status <> 'suspended' or suspended_until is not null)
);

comment on table public.profiles is
  'Student identity. One row per auth.users row, created by trigger at signup.';
comment on column public.profiles.status is
  'Moderation state. NOT updatable by the authenticated role (see column grants).';

-- THE username uniqueness guarantee. Case-insensitive, database-level.
-- Two simultaneous signups for the same handle: exactly one wins (spec §9).
create unique index profiles_username_lower_key on public.profiles (lower(username));

create index profiles_university_idx on public.profiles (university_id)
  where deleted_at is null and status = 'active';
create index profiles_department_idx on public.profiles (department_id)
  where deleted_at is null and status = 'active';
create index profiles_created_at_idx on public.profiles (created_at desc);
create index profiles_last_active_idx on public.profiles (last_active_at desc);
create index profiles_display_name_trgm_idx
  on public.profiles using gin (display_name extensions.gin_trgm_ops);
create index profiles_username_trgm_idx
  on public.profiles using gin (username extensions.gin_trgm_ops);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app.set_updated_at();


-- -----------------------------------------------------------------------------
-- Username validation: reserved list + change cooldown.
-- The database is the final authority; the live "available?" check in the UI is
-- a convenience only (spec §9).
-- -----------------------------------------------------------------------------
create or replace function app.profiles_validate_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.username = old.username then
    return new;
  end if;

  if exists (
    select 1 from public.reserved_usernames r where r.username = lower(new.username)
  ) then
    raise exception 'username "%" is reserved', new.username
      using errcode = '23514', hint = 'reserved_username';
  end if;

  -- Purely numeric handles are reserved: they collide with future numeric IDs
  -- in URLs and are a common impersonation vector ("@2024").
  if new.username ~ '^[0-9]+$' then
    raise exception 'username cannot be only digits'
      using errcode = '23514', hint = 'numeric_username';
  end if;

  if tg_op = 'UPDATE' then
    if not app.is_privileged_role()
       and old.username_changed_at is not null
       and old.username_changed_at > now() - interval '30 days' then
      raise exception 'username can only be changed once every 30 days'
        using errcode = '23514', hint = 'username_cooldown';
    end if;
    new.username_changed_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function app.profiles_validate_username() from public;

create trigger profiles_validate_username
  before insert or update of username on public.profiles
  for each row execute function app.profiles_validate_username();

-- Moderation, counters and identity columns are immutable from client roles.
create trigger profiles_protect_columns
  before update on public.profiles
  for each row execute function app.reject_protected_column_change(
    'id', 'status', 'suspended_until', 'suspension_reason', 'warning_count',
    'username_changed_at', 'created_at', 'deleted_at',
    'follower_count', 'following_count', 'connection_count',
    'post_count', 'project_count'
  );


-- -----------------------------------------------------------------------------
-- university_id must reference an approved-or-own university, and
-- department/program must actually belong to the chosen university. Without
-- this a client can point their profile at any department in the system.
-- -----------------------------------------------------------------------------
create or replace function app.profiles_validate_affiliation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.department_id is not null then
    if new.university_id is null or not exists (
      select 1 from public.departments d
      where d.id = new.department_id and d.university_id = new.university_id
    ) then
      raise exception 'department does not belong to the selected university'
        using errcode = '23514', hint = 'affiliation_mismatch';
    end if;
  end if;

  if new.program_id is not null then
    if new.department_id is null or not exists (
      select 1 from public.programs p
      where p.id = new.program_id and p.department_id = new.department_id
    ) then
      raise exception 'program does not belong to the selected department'
        using errcode = '23514', hint = 'affiliation_mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function app.profiles_validate_affiliation() from public;

create trigger profiles_validate_affiliation
  before insert or update of university_id, department_id, program_id
  on public.profiles
  for each row execute function app.profiles_validate_affiliation();


-- -----------------------------------------------------------------------------
-- universities.student_count — maintained here, where the source of truth is.
-- -----------------------------------------------------------------------------
create or replace function app.sync_university_student_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.university_id is not null and new.deleted_at is null then
      update public.universities set student_count = student_count + 1
        where id = new.university_id;
    end if;

  elsif tg_op = 'DELETE' then
    if old.university_id is not null and old.deleted_at is null then
      update public.universities set student_count = greatest(student_count - 1, 0)
        where id = old.university_id;
    end if;

  else
    -- Handles both a university switch and a soft delete/restore.
    if old.university_id is distinct from new.university_id
       or (old.deleted_at is null) is distinct from (new.deleted_at is null) then
      if old.university_id is not null and old.deleted_at is null then
        update public.universities set student_count = greatest(student_count - 1, 0)
          where id = old.university_id;
      end if;
      if new.university_id is not null and new.deleted_at is null then
        update public.universities set student_count = student_count + 1
          where id = new.university_id;
      end if;
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_university_student_count() from public;

create trigger profiles_sync_university_count
  after insert or update or delete on public.profiles
  for each row execute function app.sync_university_student_count();


-- -----------------------------------------------------------------------------
-- Signup hook. Runs as `supabase_auth_admin` inside the auth transaction, so a
-- failure here would fail the whole signup with an opaque 500. It therefore
-- swallows errors after logging a WARNING, and the app carries a safety net
-- (`ensureProfile()` in modules/profiles) for the rare miss.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_display  text;
  v_avatar   text;
begin
  -- Collision-proof placeholder derived from the user's own uuid.
  v_username := 'u' || substr(replace(new.id::text, '-', ''), 1, 12);

  v_display := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Student'
  );

  v_avatar := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'picture'), '')
  );

  insert into public.profiles (id, username, display_name, avatar_url)
  values (new.id, v_username, left(v_display, 80), v_avatar)
  on conflict (id) do nothing;

  return new;
exception when others then
  raise warning 'handle_new_user failed for %: % (%)', new.id, sqlerrm, sqlstate;
  return new;
end;
$$;

revoke execute on function app.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();


-- -----------------------------------------------------------------------------
-- Visibility predicate. Extended in 0005 (blocks, connections, same-university)
-- and 0009 (shared conversations) via CREATE OR REPLACE. Defined here so the
-- policies below can reference it.
-- -----------------------------------------------------------------------------
create or replace function app.can_view_profile(v_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = v_profile_id
      and (
        p.id = auth.uid()
        or app.is_moderator()
        or (p.deleted_at is null and p.status = 'active' and p.visibility = 'public')
      )
  );
$$;

revoke execute on function app.can_view_profile(uuid) from public;
grant execute on function app.can_view_profile(uuid) to authenticated, anon, service_role;


-- -----------------------------------------------------------------------------
-- last_active_at is not client-writable (it feeds DAU metrics). This RPC is the
-- only way to touch it, and it can only ever touch the caller's own row.
-- -----------------------------------------------------------------------------
create or replace function public.touch_last_active()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  -- Throttled: one write per 5 minutes per user, so navigation does not turn
  -- into a write storm on the profiles table.
  update public.profiles
     set last_active_at = now()
   where id = auth.uid()
     and last_active_at < now() - interval '5 minutes';
end;
$$;

revoke execute on function public.touch_last_active() from public;
grant execute on function public.touch_last_active() to authenticated;


-- =============================================================================
-- RLS + column privileges
-- =============================================================================

alter table public.profiles enable row level security;

create policy profiles_select_visible
  on public.profiles for select
  to anon, authenticated
  using (app.can_view_profile(id));

-- The signup trigger creates the row; this exists so the application-side
-- safety net can self-heal a missing profile.
create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid());

create policy profiles_update_moderator
  on public.profiles for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

-- No DELETE policy: profiles are soft-deleted through a server action. Hard
-- deletion happens via auth.users cascade, initiated by the admin API.

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to anon, authenticated;
grant insert on table public.profiles to authenticated;

-- The explicit UPDATE column list. Anything absent here is unwritable by
-- clients regardless of policy. Add to this list consciously.
grant update (
  username, display_name, avatar_url, cover_url, headline, bio,
  university_id, department_id, program_id, degree, semester, graduation_year,
  location, website, github_username, linkedin_url, twitter_username,
  visibility, allow_messages_from, allow_connection_requests, searchable,
  onboarding_completed, onboarding_step, updated_at
) on table public.profiles to authenticated;
