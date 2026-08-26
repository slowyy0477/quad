-- =============================================================================
-- 0006_skills_and_interests.sql
--
-- Skills and interests as RELATIONSHIPS, not text[] columns on profiles.
--
-- Why this matters more than it looks:
--
--   A `skills text[]` column cannot answer the question the product is actually
--   built around -- "who near me knows the thing I need?" -- because "React",
--   "react", "ReactJS" and "React.js" are four different strings. Matching,
--   search facets, and the team-finder all collapse without a canonical id.
--
--   So: a moderated catalog (`skills`), plus join tables carrying the
--   per-person data (level, learning flag, ordering).
--
-- Honesty constraint from the product spec: a skill level here is SELF-DECLARED.
-- Nothing in this schema measures competence and nothing should present it as
-- if it did. The column is named and commented accordingly.
--
-- Anti-abuse: users may propose new catalog entries, but a proposed entry is
-- invisible to everyone except its author and moderators until approved. This
-- stops the autocomplete list from becoming a graffiti wall. `usage_count` is
-- trigger-maintained and not writable by clients.
-- =============================================================================


-- =============================================================================
-- skills catalog
-- =============================================================================

create table public.skills (
  id   uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  slug text not null,

  category text not null default 'other'
           check (category in ('language', 'framework', 'tool', 'platform',
                               'database', 'design', 'data', 'devops',
                               'soft', 'academic', 'other')),

  description text check (length(description) <= 300),

  -- Unapproved entries exist but are hidden from everyone except their author
  -- and moderators. See the RLS policy below.
  is_approved boolean not null default false,

  -- Number of profiles claiming this skill. Trigger-maintained; used to rank
  -- autocomplete. Never written by a client.
  usage_count integer not null default 0,

  created_by uuid references public.profiles (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint skills_slug_key unique (slug)
);

comment on table public.skills is
  'Canonical skill catalog. Entries proposed by users start unapproved and hidden.';
comment on column public.skills.usage_count is
  'Trigger-maintained count of profile_skills rows. Not client-writable.';

create index skills_approved_idx
  on public.skills (usage_count desc, name)
  where is_approved;

create index skills_category_idx
  on public.skills (category, usage_count desc)
  where is_approved;

-- Autocomplete. Trigram index so "reac" finds "React" and "Preact".
create index skills_name_trgm_idx
  on public.skills using gin (name extensions.gin_trgm_ops);

create index skills_pending_review_idx
  on public.skills (created_at)
  where not is_approved;


create or replace function app.skills_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := btrim(new.name);

  if tg_op = 'INSERT' then
    new.slug := app.unique_slug('skills', 'slug', app.slugify(new.name));

    if not app.is_privileged_role() then
      -- A client proposing a skill does not get to decide whether it is
      -- approved, who reviewed it, or how popular it is.
      new.is_approved := false;
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.usage_count := 0;
      new.created_by  := auth.uid();
    end if;

  elsif tg_op = 'UPDATE' then
    -- Renaming a skill does not re-slug it; the slug is a stable identifier
    -- that may already be in a URL.
    if new.is_approved and not old.is_approved then
      new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
  end if;

  return new;
end;
$$;

create trigger skills_before_write
  before insert or update on public.skills
  for each row execute function app.skills_before_write();

create trigger skills_set_updated_at
  before update on public.skills
  for each row execute function app.set_updated_at();

create trigger skills_protect_columns
  before update on public.skills
  for each row execute function app.reject_protected_column_change(
    'slug', 'usage_count', 'created_by'
  );


alter table public.skills enable row level security;

-- Approved skills are public reference data -- anonymous visitors browsing a
-- public profile need to read the skill names on it.
create policy skills_select_approved
  on public.skills for select
  to anon, authenticated
  using (is_approved);

create policy skills_select_own_proposal
  on public.skills for select
  to authenticated
  using (created_by = auth.uid());

create policy skills_select_moderator
  on public.skills for select
  to authenticated
  using (app.is_moderator());

create policy skills_insert_authenticated
  on public.skills for insert
  to authenticated
  with check (created_by = auth.uid());

create policy skills_update_moderator
  on public.skills for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy skills_delete_admin
  on public.skills for delete
  to authenticated
  using (app.is_admin());

revoke all on table public.skills from anon, authenticated;
grant select on table public.skills to anon, authenticated;
grant insert on table public.skills to authenticated;
-- Only moderators pass the UPDATE policy, but the column list is still narrowed
-- so that even a moderator cannot rewrite audit fields by hand.
grant update (name, category, description, is_approved, reviewed_by,
              reviewed_at, updated_at)
  on table public.skills to authenticated;
grant delete on table public.skills to authenticated;


-- =============================================================================
-- profile_skills
-- =============================================================================

create table public.profile_skills (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  skill_id   uuid not null references public.skills (id)   on delete cascade,

  -- SELF-DECLARED. The platform does not and cannot verify this; see the file
  -- header and docs/PRODUCT.md ("skill levels are self-declared").
  level text not null default 'learning'
        check (level in ('learning', 'familiar', 'proficient', 'advanced')),

  -- "I am actively learning this right now" -- drives the learning tracker and
  -- is a different statement from `level = 'learning'`.
  is_learning boolean not null default false,

  years_experience numeric(3, 1)
                   check (years_experience is null
                          or years_experience between 0 and 60),

  -- User-controlled ordering on the profile.
  display_order integer not null default 0,

  endorsement_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (profile_id, skill_id)
);

comment on table public.profile_skills is
  'Skills a profile claims. `level` is self-declared and unverified by design.';
comment on column public.profile_skills.endorsement_count is
  'Trigger-maintained from profile_skill_endorsements. Not client-writable.';

create index profile_skills_profile_idx
  on public.profile_skills (profile_id, display_order, created_at);

-- "Who claims this skill?" -- the team-finder query.
create index profile_skills_skill_idx
  on public.profile_skills (skill_id, endorsement_count desc);

create index profile_skills_learning_idx
  on public.profile_skills (profile_id)
  where is_learning;


create or replace function app.profile_skills_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved boolean;
  v_owner    uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id        := auth.uid();
    new.endorsement_count := 0;
  end if;

  -- You may attach an approved skill, or one you proposed yourself (so the
  -- propose-then-attach flow works in one step without waiting for review).
  select s.is_approved, s.created_by
    into v_approved, v_owner
    from public.skills s
   where s.id = new.skill_id;

  if not app.is_privileged_role()
     and not coalesce(v_approved, false)
     and coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid) <> auth.uid()
  then
    raise exception 'Skill is not available'
      using errcode = '42501', hint = 'skill_not_approved';
  end if;

  return new;
end;
$$;

create trigger profile_skills_before_write
  before insert or update on public.profile_skills
  for each row execute function app.profile_skills_before_write();

create trigger profile_skills_set_updated_at
  before update on public.profile_skills
  for each row execute function app.set_updated_at();


create or replace function app.sync_skill_usage_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.skills
       set usage_count = usage_count + 1
     where id = new.skill_id;

  elsif tg_op = 'DELETE' then
    update public.skills
       set usage_count = greatest(0, usage_count - 1)
     where id = old.skill_id;
  end if;

  return null;
end;
$$;

create trigger profile_skills_sync_usage
  after insert or delete on public.profile_skills
  for each row execute function app.sync_skill_usage_count();


alter table public.profile_skills enable row level security;

-- Readable exactly when the profile itself is readable. Delegating to
-- app.can_view_profile keeps one definition of "visible" rather than two that
-- can drift apart.
create policy profile_skills_select
  on public.profile_skills for select
  to anon, authenticated
  using (app.can_view_profile(profile_id));

create policy profile_skills_insert_self
  on public.profile_skills for insert
  to authenticated
  with check (profile_id = auth.uid());

create policy profile_skills_update_self
  on public.profile_skills for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy profile_skills_delete_self
  on public.profile_skills for delete
  to authenticated
  using (profile_id = auth.uid());

create policy profile_skills_delete_moderator
  on public.profile_skills for delete
  to authenticated
  using (app.is_moderator());

revoke all on table public.profile_skills from anon, authenticated;
grant select on table public.profile_skills to anon, authenticated;
grant insert on table public.profile_skills to authenticated;
grant update (level, is_learning, years_experience, display_order, updated_at)
  on table public.profile_skills to authenticated;
grant delete on table public.profile_skills to authenticated;


-- =============================================================================
-- profile_skill_endorsements
--
-- A real counter backed by real rows. The alternative -- an `endorsements`
-- integer a client can increment -- is exactly the "fake statistic" the product
-- spec forbids, and it would also let anyone endorse themselves 400 times.
-- =============================================================================

create table public.profile_skill_endorsements (
  profile_id   uuid not null,
  skill_id     uuid not null,
  endorser_id  uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),

  primary key (profile_id, skill_id, endorser_id),

  constraint profile_skill_endorsements_target_fkey
    foreign key (profile_id, skill_id)
    references public.profile_skills (profile_id, skill_id) on delete cascade,

  -- Self-endorsement is not a signal.
  constraint profile_skill_endorsements_not_self check (profile_id <> endorser_id)
);

comment on table public.profile_skill_endorsements is
  'One row per (skill claim, endorser). Backs profile_skills.endorsement_count.';

create index profile_skill_endorsements_endorser_idx
  on public.profile_skill_endorsements (endorser_id, created_at desc);


create or replace function app.endorsements_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_privileged_role() then
    new.endorser_id := auth.uid();
  end if;

  if app.is_blocked_either_way(new.endorser_id, new.profile_id) then
    raise exception 'Not permitted'
      using errcode = '42501', hint = 'blocked';
  end if;

  return new;
end;
$$;

create trigger profile_skill_endorsements_before_insert
  before insert on public.profile_skill_endorsements
  for each row execute function app.endorsements_before_insert();


create or replace function app.sync_endorsement_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.profile_skills
       set endorsement_count = endorsement_count + 1
     where profile_id = new.profile_id and skill_id = new.skill_id;

  elsif tg_op = 'DELETE' then
    update public.profile_skills
       set endorsement_count = greatest(0, endorsement_count - 1)
     where profile_id = old.profile_id and skill_id = old.skill_id;
  end if;

  return null;
end;
$$;

create trigger profile_skill_endorsements_sync_count
  after insert or delete on public.profile_skill_endorsements
  for each row execute function app.sync_endorsement_count();


alter table public.profile_skill_endorsements enable row level security;

create policy profile_skill_endorsements_select
  on public.profile_skill_endorsements for select
  to anon, authenticated
  using (app.can_view_profile(profile_id));

create policy profile_skill_endorsements_insert
  on public.profile_skill_endorsements for insert
  to authenticated
  with check (
    endorser_id = auth.uid()
    and profile_id <> auth.uid()
    and app.can_view_profile(profile_id)
  );

-- You may withdraw your own endorsement. The endorsed user may also remove one
-- from their profile -- an unwanted endorsement is a mild harassment vector.
create policy profile_skill_endorsements_delete
  on public.profile_skill_endorsements for delete
  to authenticated
  using (endorser_id = auth.uid() or profile_id = auth.uid());

revoke all on table public.profile_skill_endorsements from anon, authenticated;
grant select on table public.profile_skill_endorsements to anon, authenticated;
grant insert, delete on table public.profile_skill_endorsements to authenticated;
-- No UPDATE grant at all: an endorsement is created or withdrawn, never edited.


-- =============================================================================
-- interests
--
-- Same catalog shape as skills, deliberately a separate table. "Machine
-- Learning" as a thing I can do and "Machine Learning" as a thing I want to
-- talk about are different claims with different levels of commitment, and
-- merging them would make both facets meaningless.
-- =============================================================================

create table public.interests (
  id   uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  slug text not null,

  category text not null default 'other'
           check (category in ('academic', 'technology', 'creative', 'business',
                               'social', 'sport', 'other')),

  is_approved boolean not null default false,
  usage_count integer not null default 0,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint interests_slug_key unique (slug)
);

create index interests_approved_idx
  on public.interests (usage_count desc, name)
  where is_approved;

create index interests_name_trgm_idx
  on public.interests using gin (name extensions.gin_trgm_ops);


create or replace function app.interests_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := btrim(new.name);

  if tg_op = 'INSERT' then
    new.slug := app.unique_slug('interests', 'slug', app.slugify(new.name));

    if not app.is_privileged_role() then
      new.is_approved := false;
      new.usage_count := 0;
      new.created_by  := auth.uid();
    end if;
  end if;

  return new;
end;
$$;

create trigger interests_before_write
  before insert or update on public.interests
  for each row execute function app.interests_before_write();

create trigger interests_set_updated_at
  before update on public.interests
  for each row execute function app.set_updated_at();

create trigger interests_protect_columns
  before update on public.interests
  for each row execute function app.reject_protected_column_change(
    'slug', 'usage_count', 'created_by'
  );


alter table public.interests enable row level security;

create policy interests_select_approved
  on public.interests for select
  to anon, authenticated
  using (is_approved);

create policy interests_select_own_proposal
  on public.interests for select
  to authenticated
  using (created_by = auth.uid());

create policy interests_select_moderator
  on public.interests for select
  to authenticated
  using (app.is_moderator());

create policy interests_insert_authenticated
  on public.interests for insert
  to authenticated
  with check (created_by = auth.uid());

create policy interests_update_moderator
  on public.interests for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy interests_delete_admin
  on public.interests for delete
  to authenticated
  using (app.is_admin());

revoke all on table public.interests from anon, authenticated;
grant select on table public.interests to anon, authenticated;
grant insert on table public.interests to authenticated;
grant update (name, category, is_approved, updated_at)
  on table public.interests to authenticated;
grant delete on table public.interests to authenticated;


-- =============================================================================
-- profile_interests
-- =============================================================================

create table public.profile_interests (
  profile_id  uuid not null references public.profiles (id)  on delete cascade,
  interest_id uuid not null references public.interests (id) on delete cascade,
  created_at  timestamptz not null default now(),

  primary key (profile_id, interest_id)
);

create index profile_interests_interest_idx
  on public.profile_interests (interest_id);


create or replace function app.profile_interests_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved boolean;
  v_owner    uuid;
begin
  if not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  select i.is_approved, i.created_by
    into v_approved, v_owner
    from public.interests i
   where i.id = new.interest_id;

  if not app.is_privileged_role()
     and not coalesce(v_approved, false)
     and coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid) <> auth.uid()
  then
    raise exception 'Interest is not available'
      using errcode = '42501', hint = 'interest_not_approved';
  end if;

  return new;
end;
$$;

create trigger profile_interests_before_insert
  before insert on public.profile_interests
  for each row execute function app.profile_interests_before_insert();


create or replace function app.sync_interest_usage_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.interests
       set usage_count = usage_count + 1
     where id = new.interest_id;
  elsif tg_op = 'DELETE' then
    update public.interests
       set usage_count = greatest(0, usage_count - 1)
     where id = old.interest_id;
  end if;
  return null;
end;
$$;

create trigger profile_interests_sync_usage
  after insert or delete on public.profile_interests
  for each row execute function app.sync_interest_usage_count();


alter table public.profile_interests enable row level security;

create policy profile_interests_select
  on public.profile_interests for select
  to anon, authenticated
  using (app.can_view_profile(profile_id));

create policy profile_interests_insert_self
  on public.profile_interests for insert
  to authenticated
  with check (profile_id = auth.uid());

create policy profile_interests_delete_self
  on public.profile_interests for delete
  to authenticated
  using (profile_id = auth.uid() or app.is_moderator());

revoke all on table public.profile_interests from anon, authenticated;
grant select on table public.profile_interests to anon, authenticated;
grant insert, delete on table public.profile_interests to authenticated;


-- =============================================================================
-- Function grants
--
-- Trigger functions are intentionally granted to nobody: Postgres does not
-- check EXECUTE when firing a trigger, so granting would only widen the
-- attack surface by making them callable directly.
-- =============================================================================

revoke execute on function app.skills_before_write()            from public;
revoke execute on function app.profile_skills_before_write()    from public;
revoke execute on function app.sync_skill_usage_count()         from public;
revoke execute on function app.endorsements_before_insert()     from public;
revoke execute on function app.sync_endorsement_count()         from public;
revoke execute on function app.interests_before_write()         from public;
revoke execute on function app.profile_interests_before_insert() from public;
revoke execute on function app.sync_interest_usage_count()      from public;
