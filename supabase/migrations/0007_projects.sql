-- =============================================================================
-- 0007_projects.sql
--
-- Projects are the object the rest of the product hangs off: posts anchor to
-- them, the team-finder searches them, the collaboration flow negotiates
-- membership of them.
--
-- Two structural decisions worth stating up front.
--
-- 1. Mutual RLS recursion is real here and is solved with SECURITY DEFINER.
--    "Can I see this project?" depends on project_members. "Can I see this
--    membership row?" depends on the project. Written as plain policy
--    subqueries those two would recurse and Postgres would error. Every
--    cross-table predicate therefore lives in an `app.*` SECURITY DEFINER
--    function, which runs with the definer's rights and so does not re-enter
--    RLS. The functions live in `app`, which is not exposed through PostgREST.
--
-- 2. Visibility is clamped to the owner's profile visibility, exactly as for
--    posts. Without this a private profile could publish a public project page
--    that names and links them, which is a privacy leak dressed up as a
--    feature.
--
-- Membership is authoritative in the database, not in the UI. Hiding the
-- "Remove member" button does nothing; the policies below are what actually
-- stop a member from evicting the owner.
-- =============================================================================


-- =============================================================================
-- projects
-- =============================================================================

create table public.projects (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,

  title   text not null check (length(btrim(title)) between 3 and 120),
  slug    text not null,
  tagline text check (length(tagline) <= 160),

  description text check (length(description) <= 10000),

  category text not null default 'other'
           check (category in ('web', 'mobile', 'ai_ml', 'data', 'game',
                               'hardware', 'research', 'design', 'social',
                               'startup', 'coursework', 'other')),

  status text not null default 'planning'
         check (status in ('planning', 'active', 'paused', 'completed',
                           'abandoned')),

  visibility text not null default 'public'
             check (visibility in ('public', 'university', 'connections',
                                   'private')),

  -- Denormalised from the owner's profile so university-scoped project lists
  -- are one index scan. Maintained by trigger, never client-written.
  university_id uuid references public.universities (id) on delete set null,

  cover_url text,
  repo_url  text check (repo_url  is null or repo_url  ~* '^https?://'),
  demo_url  text check (demo_url  is null or demo_url  ~* '^https?://'),

  -- Team-finder state. `looking_for` is prose; the machine-readable version is
  -- project_skills with is_required = true.
  is_seeking_members boolean not null default false,
  looking_for        text check (length(looking_for) <= 1000),
  team_size_target   integer check (team_size_target is null
                                    or team_size_target between 1 and 50),

  started_at   date,
  completed_at date,

  -- All trigger-maintained. See docs/PRODUCT.md: no invented numbers.
  member_count      integer not null default 0,
  star_count        integer not null default 0,
  application_count integer not null default 0,
  post_count        integer not null default 0,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint projects_slug_key unique (slug),

  -- A completed project cannot have finished before it started.
  constraint projects_dates_coherent
    check (completed_at is null or started_at is null or completed_at >= started_at),

  -- Only a completed project has a completion date.
  constraint projects_completed_status_coherent
    check (completed_at is null or status in ('completed', 'abandoned'))
);

comment on table public.projects is
  'Student projects. visibility is clamped to the owner profile visibility by trigger.';
comment on column public.projects.university_id is
  'Denormalised from owner profile. Trigger-maintained; not client-writable.';

-- Keyset pagination on the public discovery list.
create index projects_discover_idx
  on public.projects (created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index projects_owner_idx
  on public.projects (owner_id, created_at desc, id desc)
  where deleted_at is null;

create index projects_university_idx
  on public.projects (university_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index projects_category_idx
  on public.projects (category, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

-- The team-finder's primary query: open projects, most recently updated first.
create index projects_seeking_idx
  on public.projects (updated_at desc, id desc)
  where is_seeking_members
    and deleted_at is null
    and moderation_status = 'active'
    and status in ('planning', 'active');

create index projects_title_trgm_idx
  on public.projects using gin (title extensions.gin_trgm_ops);


-- =============================================================================
-- project_members
--
-- Declared here, immediately after `projects` and before any function, because
-- the authorisation helpers below are `language sql` and Postgres parses an SQL
-- function body at CREATE time. A helper that reads project_members therefore
-- cannot be defined until the table exists. (A `language plpgsql` body would
-- defer the check to first call, which only hides the ordering problem until
-- runtime.)
--
-- Triggers and policies for this table are further down, next to the rest of its
-- behaviour.
-- =============================================================================

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,

  role text not null default 'member'
       check (role in ('owner', 'maintainer', 'member')),

  -- Free-text description of what this person does on the project
  -- ("Backend", "Data pipeline"). Not a permission.
  title text check (length(title) <= 80),

  invited_by uuid references public.profiles (id) on delete set null,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (project_id, profile_id)
);

comment on column public.project_members.title is
  'Human-readable job description. Permissions come from `role`, never from this.';

-- Exactly one owner row per project. Without this, a race between two
-- role-change statements could leave a project with two owners or none.
create unique index project_members_single_owner_idx
  on public.project_members (project_id)
  where role = 'owner';

create index project_members_profile_idx
  on public.project_members (profile_id, joined_at desc);


create or replace function app.projects_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_visibility text;
  v_owner_university uuid;
begin
  new.title := btrim(new.title);

  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.owner_id          := auth.uid();
      new.member_count      := 0;
      new.star_count        := 0;
      new.application_count := 0;
      new.post_count        := 0;
      new.moderation_status := 'active';
      new.deleted_at        := null;
    end if;

    new.slug := app.unique_slug('projects', 'slug', app.slugify(new.title));
  end if;

  select p.visibility, p.university_id
    into v_owner_visibility, v_owner_university
    from public.profiles p
   where p.id = new.owner_id;

  new.university_id := v_owner_university;

  -- The clamp. A project can never be more visible than the person who owns it.
  new.visibility := app.clamp_visibility(
    new.visibility,
    coalesce(v_owner_visibility, 'private')
  );

  -- A private project cannot advertise for members; nobody who could answer
  -- would be able to see it, so the flag would only mislead the owner.
  if new.visibility = 'private' then
    new.is_seeking_members := false;
  end if;

  return new;
end;
$$;

create trigger projects_before_write
  before insert or update on public.projects
  for each row execute function app.projects_before_write();

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function app.set_updated_at();

create trigger projects_protect_columns
  before update on public.projects
  for each row execute function app.reject_protected_column_change(
    'owner_id', 'slug', 'member_count', 'star_count',
    'application_count', 'post_count', 'university_id'
  );


-- -----------------------------------------------------------------------------
-- Authorisation helpers.
--
-- SECURITY DEFINER is load-bearing, not decoration: these are called from RLS
-- policies on the very tables they read, and a SECURITY INVOKER function there
-- would recurse.
-- -----------------------------------------------------------------------------

create or replace function app.is_project_member(
  v_project_id uuid,
  v_user       uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.project_members m
     where m.project_id = v_project_id
       and m.profile_id = v_user
  );
$$;

comment on function app.is_project_member(uuid, uuid) is
  'SECURITY DEFINER to break RLS recursion between projects and project_members.';


create or replace function app.can_manage_project(
  v_project_id uuid,
  v_user       uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and (
       exists (
         select 1 from public.projects p
          where p.id = v_project_id and p.owner_id = v_user
       )
       or exists (
         select 1 from public.project_members m
          where m.project_id = v_project_id
            and m.profile_id = v_user
            and m.role in ('owner', 'maintainer')
       )
     );
$$;

comment on function app.can_manage_project(uuid, uuid) is
  'True for the project owner and for members with the maintainer role.';


create or replace function app.can_view_project(v_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner       uuid;
  v_visibility  text;
  v_university  uuid;
  v_deleted     timestamptz;
  v_moderation  text;
  v_viewer      uuid := auth.uid();
begin
  select p.owner_id, p.visibility, p.university_id, p.deleted_at,
         p.moderation_status
    into v_owner, v_visibility, v_university, v_deleted, v_moderation
    from public.projects p
   where p.id = v_project_id;

  if v_owner is null then
    return false;
  end if;

  -- Owner and moderators see it regardless of state, so that a hidden or
  -- soft-deleted project remains reachable for appeal and review.
  if v_viewer = v_owner or app.is_moderator(v_viewer) then
    return true;
  end if;

  if v_deleted is not null or v_moderation <> 'active' then
    return false;
  end if;

  -- A block hides the project from the blocked party in both directions.
  if v_viewer is not null and app.is_blocked_either_way(v_viewer, v_owner) then
    return false;
  end if;

  -- Members always see their own project, whatever its visibility.
  if v_viewer is not null and app.is_project_member(v_project_id, v_viewer) then
    return true;
  end if;

  return case v_visibility
    when 'public'      then true
    when 'university'  then v_viewer is not null
                            and v_university is not null
                            and exists (
                              select 1 from public.profiles vp
                               where vp.id = v_viewer
                                 and vp.university_id = v_university
                            )
    when 'connections' then v_viewer is not null
                            and app.are_connected(v_viewer, v_owner)
    else false
  end;
end;
$$;


create or replace function app.sync_profile_project_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Counts only projects that are actually live, so the number on a profile
  -- matches what a visitor can enumerate.
  if tg_op = 'INSERT' and new.deleted_at is null then
    update public.profiles set project_count = project_count + 1
     where id = new.owner_id;

  elsif tg_op = 'DELETE' and old.deleted_at is null then
    update public.profiles set project_count = greatest(0, project_count - 1)
     where id = old.owner_id;

  elsif tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      update public.profiles set project_count = greatest(0, project_count - 1)
       where id = old.owner_id;
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.profiles set project_count = project_count + 1
       where id = new.owner_id;
    end if;
  end if;

  return null;
end;
$$;

create trigger projects_sync_profile_count
  after insert or update or delete on public.projects
  for each row execute function app.sync_profile_project_count();


create or replace function app.sync_university_project_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.deleted_at is null and new.university_id is not null then
    update public.universities set project_count = project_count + 1
     where id = new.university_id;

  elsif tg_op = 'DELETE' and old.deleted_at is null and old.university_id is not null then
    update public.universities set project_count = greatest(0, project_count - 1)
     where id = old.university_id;

  elsif tg_op = 'UPDATE' then
    -- Handles soft delete, restore, and the owner switching university.
    if old.university_id is distinct from new.university_id
       or (old.deleted_at is null) is distinct from (new.deleted_at is null)
    then
      if old.deleted_at is null and old.university_id is not null then
        update public.universities set project_count = greatest(0, project_count - 1)
         where id = old.university_id;
      end if;
      if new.deleted_at is null and new.university_id is not null then
        update public.universities set project_count = project_count + 1
         where id = new.university_id;
      end if;
    end if;
  end if;

  return null;
end;
$$;

create trigger projects_sync_university_count
  after insert or update or delete on public.projects
  for each row execute function app.sync_university_project_count();


alter table public.projects enable row level security;

-- Written inline rather than as `app.can_view_project(id)` so the planner can
-- still use projects_discover_idx on list queries. A per-row function call in
-- the policy would force a sequential scan of every project in the table.
create policy projects_select
  on public.projects for select
  using (
    (
      deleted_at is null
      and moderation_status = 'active'
      and (
        visibility = 'public'
        or (
          visibility = 'university'
          and university_id is not null
          and exists (
            select 1 from public.profiles vp
             where vp.id = auth.uid() and vp.university_id = projects.university_id
          )
        )
        or (visibility = 'connections' and app.are_connected(auth.uid(), owner_id))
      )
      and not app.is_blocked_either_way(auth.uid(), owner_id)
    )
    or owner_id = auth.uid()
    or app.is_project_member(id)
    or app.is_moderator()
  );

create policy projects_insert_own
  on public.projects for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy projects_update_manage
  on public.projects for update
  to authenticated
  using (app.can_manage_project(id))
  with check (app.can_manage_project(id));

create policy projects_update_moderator
  on public.projects for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

-- Hard delete is owner-only. Everyone else soft-deletes via `deleted_at`, which
-- keeps the project available for moderation review.
create policy projects_delete_own
  on public.projects for delete
  to authenticated
  using (owner_id = auth.uid());

create policy projects_delete_admin
  on public.projects for delete
  to authenticated
  using (app.is_admin());

revoke all on table public.projects from anon, authenticated;
grant select on table public.projects to anon, authenticated;
grant insert on table public.projects to authenticated;
-- The narrow column list is the real defence. `moderation_status` is absent, so
-- a project owner cannot un-hide their own hidden project even though they pass
-- the projects_update_manage policy.
grant update (title, tagline, description, category, status, visibility,
              cover_url, repo_url, demo_url, is_seeking_members, looking_for,
              team_size_target, started_at, completed_at, deleted_at, updated_at)
  on table public.projects to authenticated;
grant delete on table public.projects to authenticated;


-- =============================================================================
-- project_members -- triggers, policies and grants
--
-- The table itself is declared above, next to `projects`.
-- =============================================================================

create or replace function app.project_members_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select p.owner_id into v_owner from public.projects p where p.id = new.project_id;

  if tg_op = 'INSERT' then
    -- The owner's own membership row is the only one that may carry the owner
    -- role, and it is created by app.projects_after_insert.
    if new.profile_id = v_owner then
      new.role := 'owner';
    elsif new.role = 'owner' then
      raise exception 'A project has exactly one owner'
        using errcode = '42501', hint = 'owner_role_reserved';
    end if;

    if not app.is_privileged_role() then
      new.invited_by := coalesce(new.invited_by, auth.uid());
    end if;

  elsif tg_op = 'UPDATE' then
    -- Ownership transfer is a deliberate, separate operation
    -- (app.transfer_project_ownership), not a role edit.
    if old.role = 'owner' and new.role <> 'owner' then
      raise exception 'Cannot demote the project owner'
        using errcode = '42501', hint = 'owner_role_immutable';
    end if;
    if new.role = 'owner' and old.role <> 'owner' then
      raise exception 'Use transfer_project_ownership to change owner'
        using errcode = '42501', hint = 'owner_role_reserved';
    end if;
  end if;

  return new;
end;
$$;

create trigger project_members_before_write
  before insert or update on public.project_members
  for each row execute function app.project_members_before_write();

create trigger project_members_set_updated_at
  before update on public.project_members
  for each row execute function app.set_updated_at();

create trigger project_members_protect_columns
  before update on public.project_members
  for each row execute function app.reject_protected_column_change(
    'project_id', 'profile_id', 'invited_by', 'joined_at'
  );


create or replace function app.prevent_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_exists boolean;
begin
  -- When the whole project is being deleted the cascade removes this row too;
  -- that is legitimate, so only block the standalone case.
  select exists (select 1 from public.projects p where p.id = old.project_id)
    into v_project_exists;

  if v_project_exists and old.role = 'owner' then
    raise exception 'The project owner cannot leave; transfer or delete the project'
      using errcode = '42501', hint = 'owner_cannot_leave';
  end if;

  return old;
end;
$$;

create trigger project_members_prevent_owner_removal
  before delete on public.project_members
  for each row execute function app.prevent_owner_removal();


create or replace function app.sync_project_member_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.projects set member_count = member_count + 1
     where id = new.project_id;
  elsif tg_op = 'DELETE' then
    update public.projects set member_count = greatest(0, member_count - 1)
     where id = old.project_id;
  end if;
  return null;
end;
$$;

create trigger project_members_sync_count
  after insert or delete on public.project_members
  for each row execute function app.sync_project_member_count();


-- The owner joins their own project automatically. Without this the owner is
-- absent from the member list and member_count reads 0 on a project that
-- demonstrably has one person on it.
create or replace function app.projects_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, profile_id, role, invited_by)
  values (new.id, new.owner_id, 'owner', new.owner_id)
  on conflict do nothing;

  return null;
end;
$$;

create trigger projects_after_insert
  after insert on public.projects
  for each row execute function app.projects_after_insert();


alter table public.project_members enable row level security;

create policy project_members_select
  on public.project_members for select
  using (app.can_view_project(project_id));

-- Owners and maintainers add members directly (used by the accept-application
-- and accept-invite paths, which run as the manager).
create policy project_members_insert_manage
  on public.project_members for insert
  to authenticated
  with check (app.can_manage_project(project_id));

create policy project_members_update_manage
  on public.project_members for update
  to authenticated
  using (app.can_manage_project(project_id))
  with check (app.can_manage_project(project_id));

-- A member may edit only their own `title`. The column grant plus this policy
-- means they cannot promote themselves to maintainer.
create policy project_members_update_self
  on public.project_members for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid() and role = 'member');

create policy project_members_delete_manage
  on public.project_members for delete
  to authenticated
  using (app.can_manage_project(project_id));

-- Leaving is always allowed (except for the owner, blocked by trigger above).
create policy project_members_delete_self
  on public.project_members for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.project_members from anon, authenticated;
grant select on table public.project_members to anon, authenticated;
grant insert on table public.project_members to authenticated;
grant update (role, title, updated_at) on table public.project_members to authenticated;
grant delete on table public.project_members to authenticated;


-- =============================================================================
-- Ownership transfer
--
-- Two rows must change atomically and the single-owner index must hold at every
-- point in between, which a client cannot arrange with two separate UPDATEs.
-- =============================================================================

create or replace function public.transfer_project_ownership(
  p_project_id uuid,
  p_new_owner  uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_owner uuid;
begin
  select p.owner_id into v_current_owner
    from public.projects p
   where p.id = p_project_id
     and p.deleted_at is null;

  if v_current_owner is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;

  -- Only the current owner may transfer. Not maintainers.
  if v_current_owner <> auth.uid() and not app.is_admin() then
    raise exception 'Not permitted'
      using errcode = '42501', hint = 'not_project_owner';
  end if;

  if p_new_owner = v_current_owner then
    return;
  end if;

  if not exists (
    select 1 from public.project_members m
     where m.project_id = p_project_id and m.profile_id = p_new_owner
  ) then
    raise exception 'The new owner must already be a project member'
      using errcode = '23514', hint = 'new_owner_not_member';
  end if;

  -- Vacate the owner slot first so the partial unique index is never violated.
  update public.project_members
     set role = 'maintainer'
   where project_id = p_project_id and profile_id = v_current_owner;

  update public.projects
     set owner_id = p_new_owner
   where id = p_project_id;

  update public.project_members
     set role = 'owner'
   where project_id = p_project_id and profile_id = p_new_owner;
end;
$$;

revoke execute on function public.transfer_project_ownership(uuid, uuid) from public;
grant execute on function public.transfer_project_ownership(uuid, uuid)
  to authenticated;


-- =============================================================================
-- project_applications
--
-- The join-request direction: a student asks to be on a project.
-- =============================================================================

create table public.project_applications (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  applicant_id uuid not null references public.profiles (id) on delete cascade,

  message text check (length(message) <= 2000),

  -- What the applicant wants to do. Free text, deliberately not a permission.
  desired_role text check (length(desired_role) <= 80),

  status text not null default 'pending'
         check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),

  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (length(review_note) <= 1000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One live application per person per project. A rejected applicant can
  -- reapply only after the old row is cleared, which is deliberate: it stops
  -- application spam without a separate rate limiter.
  constraint project_applications_unique unique (project_id, applicant_id)
);

create index project_applications_project_idx
  on public.project_applications (project_id, created_at desc)
  where status = 'pending';

create index project_applications_applicant_idx
  on public.project_applications (applicant_id, created_at desc);


create or replace function app.project_applications_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid;
  v_seeking boolean;
begin
  if tg_op = 'INSERT' then
    select p.owner_id, p.is_seeking_members
      into v_owner, v_seeking
      from public.projects p
     where p.id = new.project_id and p.deleted_at is null;

    if v_owner is null then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;

    if not app.is_privileged_role() then
      new.applicant_id := auth.uid();
      new.status       := 'pending';
      new.reviewed_by  := null;
      new.reviewed_at  := null;
      new.review_note  := null;
    end if;

    if new.applicant_id = v_owner then
      raise exception 'You already own this project'
        using errcode = '23514', hint = 'own_project';
    end if;

    if app.is_project_member(new.project_id, new.applicant_id) then
      raise exception 'You are already a member of this project'
        using errcode = '23514', hint = 'already_member';
    end if;

    if app.is_blocked_either_way(new.applicant_id, v_owner) then
      raise exception 'Not permitted'
        using errcode = '42501', hint = 'blocked';
    end if;

    -- Applying to a project that is not open is not a meaningful action, and
    -- allowing it would turn the applications table into a message channel that
    -- bypasses the recipient's messaging preferences.
    if not coalesce(v_seeking, false) then
      raise exception 'This project is not accepting applications'
        using errcode = '42501', hint = 'not_seeking_members';
    end if;

  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status and new.status <> 'withdrawn' then
      new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
  end if;

  return new;
end;
$$;

create trigger project_applications_before_write
  before insert or update on public.project_applications
  for each row execute function app.project_applications_before_write();

create trigger project_applications_set_updated_at
  before update on public.project_applications
  for each row execute function app.set_updated_at();

create trigger project_applications_protect_columns
  before update on public.project_applications
  for each row execute function app.reject_protected_column_change(
    'project_id', 'applicant_id', 'created_at'
  );


-- Accepting an application creates the membership row. Doing this in the
-- database rather than in a Server Action means the two facts cannot drift
-- apart if the request dies halfway.
create or replace function app.project_applications_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status <> 'accepted' then
    insert into public.project_members
      (project_id, profile_id, role, title, invited_by)
    values
      (new.project_id, new.applicant_id, 'member', new.desired_role, new.reviewed_by)
    on conflict (project_id, profile_id) do nothing;
  end if;

  return null;
end;
$$;

create trigger project_applications_after_update
  after update on public.project_applications
  for each row execute function app.project_applications_after_update();


create or replace function app.sync_project_application_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Counts pending applications only: that is the number the owner needs to
  -- act on, and the only one that means anything on a badge.
  if tg_op = 'INSERT' and new.status = 'pending' then
    update public.projects set application_count = application_count + 1
     where id = new.project_id;

  elsif tg_op = 'DELETE' and old.status = 'pending' then
    update public.projects set application_count = greatest(0, application_count - 1)
     where id = old.project_id;

  elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
    if old.status = 'pending' then
      update public.projects set application_count = greatest(0, application_count - 1)
       where id = new.project_id;
    elsif new.status = 'pending' then
      update public.projects set application_count = application_count + 1
       where id = new.project_id;
    end if;
  end if;

  return null;
end;
$$;

create trigger project_applications_sync_count
  after insert or update or delete on public.project_applications
  for each row execute function app.sync_project_application_count();


alter table public.project_applications enable row level security;

-- An application is private between the applicant and the project managers.
-- Other members of the project cannot read it.
create policy project_applications_select_applicant
  on public.project_applications for select
  to authenticated
  using (applicant_id = auth.uid());

create policy project_applications_select_manage
  on public.project_applications for select
  to authenticated
  using (app.can_manage_project(project_id));

create policy project_applications_select_moderator
  on public.project_applications for select
  to authenticated
  using (app.is_moderator());

create policy project_applications_insert_self
  on public.project_applications for insert
  to authenticated
  with check (applicant_id = auth.uid() and app.can_view_project(project_id));

-- Managers accept or reject.
create policy project_applications_update_manage
  on public.project_applications for update
  to authenticated
  using (app.can_manage_project(project_id))
  with check (
    app.can_manage_project(project_id)
    and status in ('accepted', 'rejected', 'pending')
  );

-- The applicant may only ever move their own application to 'withdrawn'. This
-- is the check that stops a self-accept.
create policy project_applications_update_withdraw
  on public.project_applications for update
  to authenticated
  using (applicant_id = auth.uid() and status = 'pending')
  with check (applicant_id = auth.uid() and status = 'withdrawn');

create policy project_applications_delete
  on public.project_applications for delete
  to authenticated
  using (applicant_id = auth.uid() or app.can_manage_project(project_id));

revoke all on table public.project_applications from anon, authenticated;
grant select on table public.project_applications to authenticated;
grant insert on table public.project_applications to authenticated;
grant update (status, review_note, reviewed_by, reviewed_at, updated_at)
  on table public.project_applications to authenticated;
grant delete on table public.project_applications to authenticated;


-- =============================================================================
-- project_invites
--
-- The other direction: a project asks a student to join. Kept separate from
-- applications because the author, the approver, and the notification target
-- are all reversed.
-- =============================================================================

create table public.project_invites (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  invitee_id uuid not null references public.profiles (id) on delete cascade,
  inviter_id uuid not null references public.profiles (id) on delete cascade,

  message      text check (length(message) <= 1000),
  proposed_role text check (length(proposed_role) <= 80),

  status text not null default 'pending'
         check (status in ('pending', 'accepted', 'declined', 'revoked')),

  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint project_invites_unique unique (project_id, invitee_id),
  constraint project_invites_not_self check (invitee_id <> inviter_id)
);

create index project_invites_invitee_idx
  on public.project_invites (invitee_id, created_at desc)
  where status = 'pending';

create index project_invites_project_idx
  on public.project_invites (project_id, created_at desc);


create or replace function app.project_invites_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.inviter_id   := auth.uid();
      new.status       := 'pending';
      new.responded_at := null;
    end if;

    if app.is_project_member(new.project_id, new.invitee_id) then
      raise exception 'That person is already a member'
        using errcode = '23514', hint = 'already_member';
    end if;

    if app.is_blocked_either_way(new.inviter_id, new.invitee_id) then
      raise exception 'Not permitted'
        using errcode = '42501', hint = 'blocked';
    end if;

    -- An invite is an unsolicited approach, so it respects the same preference
    -- as connection requests rather than inventing a second, weaker rule.
    if not exists (
      select 1 from public.profiles p
       where p.id = new.invitee_id and p.allow_connection_requests
    ) then
      raise exception 'That person is not accepting invitations'
        using errcode = '42501', hint = 'invites_disabled';
    end if;

  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      new.responded_at := coalesce(new.responded_at, now());
    end if;
  end if;

  return new;
end;
$$;

create trigger project_invites_before_write
  before insert or update on public.project_invites
  for each row execute function app.project_invites_before_write();

create trigger project_invites_set_updated_at
  before update on public.project_invites
  for each row execute function app.set_updated_at();

create trigger project_invites_protect_columns
  before update on public.project_invites
  for each row execute function app.reject_protected_column_change(
    'project_id', 'invitee_id', 'inviter_id', 'created_at'
  );


create or replace function app.project_invites_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status <> 'accepted' then
    insert into public.project_members
      (project_id, profile_id, role, title, invited_by)
    values
      (new.project_id, new.invitee_id, 'member', new.proposed_role, new.inviter_id)
    on conflict (project_id, profile_id) do nothing;
  end if;

  return null;
end;
$$;

create trigger project_invites_after_update
  after update on public.project_invites
  for each row execute function app.project_invites_after_update();


alter table public.project_invites enable row level security;

create policy project_invites_select_invitee
  on public.project_invites for select
  to authenticated
  using (invitee_id = auth.uid());

create policy project_invites_select_manage
  on public.project_invites for select
  to authenticated
  using (app.can_manage_project(project_id));

create policy project_invites_insert_manage
  on public.project_invites for insert
  to authenticated
  with check (inviter_id = auth.uid() and app.can_manage_project(project_id));

-- Only the invitee accepts or declines.
create policy project_invites_update_invitee
  on public.project_invites for update
  to authenticated
  using (invitee_id = auth.uid() and status = 'pending')
  with check (invitee_id = auth.uid() and status in ('accepted', 'declined'));

-- Only a manager revokes.
create policy project_invites_update_manage
  on public.project_invites for update
  to authenticated
  using (app.can_manage_project(project_id) and status = 'pending')
  with check (app.can_manage_project(project_id) and status = 'revoked');

create policy project_invites_delete
  on public.project_invites for delete
  to authenticated
  using (invitee_id = auth.uid() or app.can_manage_project(project_id));

revoke all on table public.project_invites from anon, authenticated;
grant select on table public.project_invites to authenticated;
grant insert on table public.project_invites to authenticated;
grant update (status, responded_at, updated_at)
  on table public.project_invites to authenticated;
grant delete on table public.project_invites to authenticated;


-- =============================================================================
-- project_skills
--
-- Two facts in one table, separated by `is_required`:
--   false -> "this project uses X"   (portfolio signal)
--   true  -> "this project needs X"  (team-finder signal)
-- =============================================================================

create table public.project_skills (
  project_id uuid not null references public.projects (id) on delete cascade,
  skill_id   uuid not null references public.skills (id)   on delete cascade,

  is_required boolean not null default false,
  created_at  timestamptz not null default now(),

  primary key (project_id, skill_id)
);

create index project_skills_skill_idx
  on public.project_skills (skill_id)
  where is_required;


create or replace function app.project_skills_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved boolean;
  v_owner    uuid;
begin
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

create trigger project_skills_before_insert
  before insert on public.project_skills
  for each row execute function app.project_skills_before_insert();


alter table public.project_skills enable row level security;

create policy project_skills_select
  on public.project_skills for select
  using (app.can_view_project(project_id));

create policy project_skills_write_manage
  on public.project_skills for insert
  to authenticated
  with check (app.can_manage_project(project_id));

create policy project_skills_update_manage
  on public.project_skills for update
  to authenticated
  using (app.can_manage_project(project_id))
  with check (app.can_manage_project(project_id));

create policy project_skills_delete_manage
  on public.project_skills for delete
  to authenticated
  using (app.can_manage_project(project_id));

revoke all on table public.project_skills from anon, authenticated;
grant select on table public.project_skills to anon, authenticated;
grant insert, delete on table public.project_skills to authenticated;
grant update (is_required) on table public.project_skills to authenticated;


-- =============================================================================
-- project_media
--
-- Same upload constraints as post media: a whitelist of MIME types and a hard
-- size ceiling, enforced in the database so a forged client request cannot
-- register an executable as a screenshot. Storage-level policies in the storage
-- migration are the second half of this.
-- =============================================================================

create table public.project_media (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,

  storage_path text not null,
  mime_type    text not null
               check (mime_type in ('image/jpeg', 'image/png', 'image/webp',
                                    'image/gif')),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 5242880),

  width  integer check (width  is null or width  between 1 and 20000),
  height integer check (height is null or height between 1 and 20000),

  alt_text text check (length(alt_text) <= 300),

  display_order integer not null default 0,
  uploaded_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint project_media_path_key unique (storage_path)
);

comment on column public.project_media.alt_text is
  'Required for accessibility in the UI layer; nullable here so legacy rows and
   moderation flows are not blocked by it.';

create index project_media_project_idx
  on public.project_media (project_id, display_order, created_at);


create or replace function app.project_media_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_privileged_role() then
    new.uploaded_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger project_media_before_insert
  before insert on public.project_media
  for each row execute function app.project_media_before_insert();


alter table public.project_media enable row level security;

create policy project_media_select
  on public.project_media for select
  using (app.can_view_project(project_id));

create policy project_media_insert_manage
  on public.project_media for insert
  to authenticated
  with check (app.can_manage_project(project_id) and uploaded_by = auth.uid());

create policy project_media_update_manage
  on public.project_media for update
  to authenticated
  using (app.can_manage_project(project_id))
  with check (app.can_manage_project(project_id));

create policy project_media_delete_manage
  on public.project_media for delete
  to authenticated
  using (app.can_manage_project(project_id) or app.is_moderator());

revoke all on table public.project_media from anon, authenticated;
grant select on table public.project_media to anon, authenticated;
grant insert on table public.project_media to authenticated;
grant update (alt_text, display_order) on table public.project_media to authenticated;
grant delete on table public.project_media to authenticated;


-- =============================================================================
-- project_stars
-- =============================================================================

create table public.project_stars (
  project_id uuid not null references public.projects (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (project_id, profile_id)
);

create index project_stars_profile_idx
  on public.project_stars (profile_id, created_at desc);


create or replace function app.project_stars_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;
  return new;
end;
$$;

create trigger project_stars_before_insert
  before insert on public.project_stars
  for each row execute function app.project_stars_before_insert();


create or replace function app.sync_project_star_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.projects set star_count = star_count + 1
     where id = new.project_id;
  elsif tg_op = 'DELETE' then
    update public.projects set star_count = greatest(0, star_count - 1)
     where id = old.project_id;
  end if;
  return null;
end;
$$;

create trigger project_stars_sync_count
  after insert or delete on public.project_stars
  for each row execute function app.sync_project_star_count();


alter table public.project_stars enable row level security;

create policy project_stars_select
  on public.project_stars for select
  using (app.can_view_project(project_id));

create policy project_stars_insert_self
  on public.project_stars for insert
  to authenticated
  with check (profile_id = auth.uid() and app.can_view_project(project_id));

create policy project_stars_delete_self
  on public.project_stars for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.project_stars from anon, authenticated;
grant select on table public.project_stars to anon, authenticated;
grant insert, delete on table public.project_stars to authenticated;


-- =============================================================================
-- Function grants
-- =============================================================================

revoke execute on function app.is_project_member(uuid, uuid)   from public;
revoke execute on function app.can_manage_project(uuid, uuid)  from public;
revoke execute on function app.can_view_project(uuid)          from public;

grant execute on function app.is_project_member(uuid, uuid)
  to anon, authenticated, service_role;
grant execute on function app.can_manage_project(uuid, uuid)
  to anon, authenticated, service_role;
grant execute on function app.can_view_project(uuid)
  to anon, authenticated, service_role;

-- Trigger functions: not granted, see the note in 0006.
revoke execute on function app.projects_before_write()               from public;
revoke execute on function app.projects_after_insert()               from public;
revoke execute on function app.sync_profile_project_count()          from public;
revoke execute on function app.sync_university_project_count()       from public;
revoke execute on function app.project_members_before_write()        from public;
revoke execute on function app.prevent_owner_removal()               from public;
revoke execute on function app.sync_project_member_count()           from public;
revoke execute on function app.project_applications_before_write()   from public;
revoke execute on function app.project_applications_after_update()   from public;
revoke execute on function app.sync_project_application_count()      from public;
revoke execute on function app.project_invites_before_write()        from public;
revoke execute on function app.project_invites_after_update()        from public;
revoke execute on function app.project_skills_before_insert()        from public;
revoke execute on function app.project_media_before_insert()         from public;
revoke execute on function app.project_stars_before_insert()         from public;
revoke execute on function app.sync_project_star_count()             from public;
