-- =============================================================================
-- 0009_ideas.sql
--
-- An idea is a project that does not exist yet.
--
-- That distinction is the whole justification for a separate table. A project
-- has members, a repository, a status and a history; an idea has none of those,
-- only a proposition and a question ("who wants to build this?"). Modelling an
-- idea as a project with status='planning' would mean every project list, every
-- member count and every portfolio view has to filter out things that were never
-- really projects.
--
-- The lifecycle terminates in a real state change: when an idea gathers a team
-- it CONVERTS to a project, and `converted_project_id` records that. An idea is
-- then closed for good -- it does not linger as a duplicate of the project it
-- became.
-- =============================================================================

create table public.ideas (
  id        uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,

  title       text not null check (length(btrim(title)) between 5 and 140),
  description text not null check (length(btrim(description)) between 20 and 5000),

  category text not null default 'other'
           check (category in ('web', 'mobile', 'ai_ml', 'data', 'game',
                               'hardware', 'research', 'design', 'social',
                               'startup', 'coursework', 'other')),

  -- Prose. The machine-readable version is idea_skills.
  looking_for text check (length(looking_for) <= 1000),

  status text not null default 'open'
         check (status in ('open', 'forming', 'converted', 'closed')),

  visibility text not null default 'public'
             check (visibility in ('public', 'university', 'connections',
                                   'private')),

  university_id uuid references public.universities (id) on delete set null,

  -- Set when the idea becomes a project. The FK is ON DELETE SET NULL rather
  -- than CASCADE: deleting the project should not erase the record that the
  -- idea existed and found a team.
  converted_project_id uuid references public.projects (id) on delete set null,
  converted_at         timestamptz,

  upvote_count  integer not null default 0,
  comment_count integer not null default 0,
  interest_count integer not null default 0,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- The two facts must agree: converted implies a project and a timestamp.
  constraint ideas_conversion_coherent check (
    (status = 'converted') = (converted_project_id is not null)
  ),
  constraint ideas_converted_at_coherent check (
    (converted_project_id is null) = (converted_at is null)
  )
);

comment on table public.ideas is
  'Propositions looking for a team. Converts to a project once it has one.';

create index ideas_browse_idx
  on public.ideas (created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active'
    and status in ('open', 'forming');

-- The default board sort: most-supported open ideas.
create index ideas_popular_idx
  on public.ideas (upvote_count desc, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active'
    and status in ('open', 'forming');

create index ideas_author_idx
  on public.ideas (author_id, created_at desc, id desc)
  where deleted_at is null;

create index ideas_university_idx
  on public.ideas (university_id, created_at desc, id desc)
  where deleted_at is null and moderation_status = 'active';

create index ideas_title_trgm_idx
  on public.ideas using gin (title extensions.gin_trgm_ops);


create or replace function app.ideas_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_visibility text;
  v_author_university uuid;
begin
  new.title       := btrim(new.title);
  new.description := btrim(new.description);

  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.author_id            := auth.uid();
    new.upvote_count         := 0;
    new.comment_count        := 0;
    new.interest_count       := 0;
    new.moderation_status    := 'active';
    new.status               := 'open';
    new.converted_project_id := null;
    new.converted_at         := null;
    new.deleted_at           := null;
  end if;

  select p.visibility, p.university_id
    into v_author_visibility, v_author_university
    from public.profiles p
   where p.id = new.author_id;

  new.university_id := v_author_university;
  new.visibility := app.clamp_visibility(
    new.visibility, coalesce(v_author_visibility, 'private')
  );

  -- Conversion is done through public.convert_idea_to_project, which sets both
  -- columns together and marks the transaction with app.begin_trusted_write().
  -- Blocking the direct path keeps the coherence constraints from being the only
  -- thing standing between us and a half-converted idea.
  if tg_op = 'UPDATE'
     and not app.is_marked_trusted_write()
     and new.converted_project_id is distinct from old.converted_project_id
  then
    raise exception 'Use convert_idea_to_project to convert an idea'
      using errcode = '42501', hint = 'use_conversion_function';
  end if;

  return new;
end;
$$;

create trigger ideas_before_write
  before insert or update on public.ideas
  for each row execute function app.ideas_before_write();

create trigger ideas_set_updated_at
  before update on public.ideas
  for each row execute function app.set_updated_at();

create trigger ideas_protect_columns
  before update on public.ideas
  for each row execute function app.reject_protected_column_change(
    'author_id', 'created_at', 'upvote_count', 'comment_count',
    'interest_count', 'university_id', 'converted_at'
  );


create or replace function app.can_view_idea(v_idea_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_author     uuid;
  v_visibility text;
  v_university uuid;
  v_deleted    timestamptz;
  v_moderation text;
  v_viewer     uuid := auth.uid();
begin
  select i.author_id, i.visibility, i.university_id, i.deleted_at,
         i.moderation_status
    into v_author, v_visibility, v_university, v_deleted, v_moderation
    from public.ideas i
   where i.id = v_idea_id;

  if v_author is null then
    return false;
  end if;

  if v_viewer = v_author or app.is_moderator(v_viewer) then
    return true;
  end if;

  if v_deleted is not null or v_moderation <> 'active' then
    return false;
  end if;

  if v_viewer is not null and app.is_blocked_either_way(v_viewer, v_author) then
    return false;
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
                            and app.are_connected(v_viewer, v_author)
    else false
  end;
end;
$$;


alter table public.ideas enable row level security;

-- Inline rather than a can_view_idea() call so the board's list query can use
-- ideas_popular_idx instead of evaluating a function for every row.
create policy ideas_select
  on public.ideas for select
  to anon, authenticated
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
             where vp.id = auth.uid() and vp.university_id = ideas.university_id
          )
        )
        or (visibility = 'connections' and app.are_connected(auth.uid(), author_id))
      )
      and not app.is_blocked_either_way(auth.uid(), author_id)
    )
    or author_id = auth.uid()
    or app.is_moderator()
  );

create policy ideas_insert_own
  on public.ideas for insert
  to authenticated
  with check (author_id = auth.uid());

create policy ideas_update_own
  on public.ideas for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy ideas_update_moderator
  on public.ideas for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

create policy ideas_delete_own
  on public.ideas for delete
  to authenticated
  using (author_id = auth.uid() or app.is_admin());

revoke all on table public.ideas from anon, authenticated;
grant select on table public.ideas to anon, authenticated;
grant insert on table public.ideas to authenticated;
-- `converted_project_id` is absent: conversion goes through the function below.
grant update (title, description, category, looking_for, status, visibility,
              deleted_at, updated_at)
  on table public.ideas to authenticated;
grant delete on table public.ideas to authenticated;


-- =============================================================================
-- idea_skills
--
-- Declared before the conversion function below, which reads it.
-- =============================================================================

create table public.idea_skills (
  idea_id  uuid not null references public.ideas (id)  on delete cascade,
  skill_id uuid not null references public.skills (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (idea_id, skill_id)
);

create index idea_skills_skill_idx on public.idea_skills (skill_id);

alter table public.idea_skills enable row level security;

create policy idea_skills_select
  on public.idea_skills for select
  to anon, authenticated
  using (app.can_view_idea(idea_id));

create policy idea_skills_write_author
  on public.idea_skills for insert
  to authenticated
  with check (
    exists (select 1 from public.ideas i
             where i.id = idea_id and i.author_id = auth.uid())
  );

create policy idea_skills_delete_author
  on public.idea_skills for delete
  to authenticated
  using (
    exists (select 1 from public.ideas i
             where i.id = idea_id and i.author_id = auth.uid())
  );

revoke all on table public.idea_skills from anon, authenticated;
grant select on table public.idea_skills to anon, authenticated;
grant insert, delete on table public.idea_skills to authenticated;


-- =============================================================================
-- Conversion
--
-- Creating the project and marking the idea converted must happen together. A
-- client doing it in two statements can leave an idea permanently pointing at
-- nothing, or a project with no record of where it came from.
-- =============================================================================

create or replace function public.convert_idea_to_project(p_idea_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idea    public.ideas;
  v_project uuid;
begin
  select * into v_idea
    from public.ideas
   where id = p_idea_id and deleted_at is null;

  if v_idea.id is null then
    raise exception 'Idea not found' using errcode = 'P0002';
  end if;

  if v_idea.author_id <> auth.uid() and not app.is_admin() then
    raise exception 'Not permitted'
      using errcode = '42501', hint = 'not_idea_author';
  end if;

  if v_idea.status = 'converted' then
    raise exception 'This idea has already become a project'
      using errcode = '23505', hint = 'already_converted';
  end if;

  -- The project is created on the idea author's behalf, which means naming an
  -- owner_id rather than letting the trigger default it to the caller. That is a
  -- protected write, so it is declared trusted here; it also covers the
  -- converted_project_id update at the end of this function.
  perform app.begin_trusted_write();

  insert into public.projects
    (owner_id, title, tagline, description, category, status, visibility,
     looking_for, is_seeking_members)
  values
    (v_idea.author_id, v_idea.title, left(coalesce(v_idea.looking_for, ''), 160),
     v_idea.description, v_idea.category, 'planning', v_idea.visibility,
     v_idea.looking_for, true)
  returning id into v_project;

  -- Carry the required skills across so the team-finder does not lose the
  -- machine-readable half of the ask.
  insert into public.project_skills (project_id, skill_id, is_required)
  select v_project, s.skill_id, true
    from public.idea_skills s
   where s.idea_id = p_idea_id
  on conflict do nothing;

  update public.ideas
     set status               = 'converted',
         converted_project_id = v_project,
         converted_at         = now()
   where id = p_idea_id;

  return v_project;
end;
$$;

revoke execute on function public.convert_idea_to_project(uuid) from public;
grant execute on function public.convert_idea_to_project(uuid) to authenticated;


-- =============================================================================
-- idea_votes
--
-- "I think this is worth building." Distinct from idea_interest below, which is
-- "I want to build it with you" -- a much stronger signal, and the one that
-- actually forms teams.
-- =============================================================================

create table public.idea_votes (
  idea_id    uuid not null references public.ideas (id)    on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (idea_id, profile_id)
);

create index idea_votes_profile_idx on public.idea_votes (profile_id, created_at desc);


create or replace function app.idea_votes_before_insert()
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

create trigger idea_votes_before_insert
  before insert on public.idea_votes
  for each row execute function app.idea_votes_before_insert();


create or replace function app.sync_idea_vote_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.ideas set upvote_count = upvote_count + 1
     where id = new.idea_id;
  elsif tg_op = 'DELETE' then
    update public.ideas set upvote_count = greatest(0, upvote_count - 1)
     where id = old.idea_id;
  end if;
  return null;
end;
$$;

create trigger idea_votes_sync_count
  after insert or delete on public.idea_votes
  for each row execute function app.sync_idea_vote_count();


alter table public.idea_votes enable row level security;

create policy idea_votes_select
  on public.idea_votes for select
  to anon, authenticated
  using (app.can_view_idea(idea_id));

create policy idea_votes_insert_self
  on public.idea_votes for insert
  to authenticated
  with check (profile_id = auth.uid() and app.can_view_idea(idea_id));

create policy idea_votes_delete_self
  on public.idea_votes for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.idea_votes from anon, authenticated;
grant select on table public.idea_votes to anon, authenticated;
grant insert, delete on table public.idea_votes to authenticated;


-- =============================================================================
-- idea_interest
--
-- "I want to help build this." Carries a message, because a bare signal gives
-- the author nothing to act on.
-- =============================================================================

create table public.idea_interest (
  idea_id    uuid not null references public.ideas (id)    on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,

  message text check (length(message) <= 1000),
  -- What they would like to contribute. Free text; the structured version is
  -- their profile_skills.
  offering text check (length(offering) <= 200),

  created_at timestamptz not null default now(),

  primary key (idea_id, profile_id)
);

create index idea_interest_profile_idx
  on public.idea_interest (profile_id, created_at desc);


create or replace function app.idea_interest_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  if not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  select i.author_id into v_author from public.ideas i where i.id = new.idea_id;

  if v_author = new.profile_id then
    raise exception 'You proposed this idea'
      using errcode = '23514', hint = 'own_idea';
  end if;

  if app.is_blocked_either_way(new.profile_id, v_author) then
    raise exception 'Not permitted'
      using errcode = '42501', hint = 'blocked';
  end if;

  return new;
end;
$$;

create trigger idea_interest_before_insert
  before insert on public.idea_interest
  for each row execute function app.idea_interest_before_insert();


create or replace function app.sync_idea_interest_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.ideas set interest_count = interest_count + 1
     where id = new.idea_id;
  elsif tg_op = 'DELETE' then
    update public.ideas set interest_count = greatest(0, interest_count - 1)
     where id = old.idea_id;
  end if;
  return null;
end;
$$;

create trigger idea_interest_sync_count
  after insert or delete on public.idea_interest
  for each row execute function app.sync_idea_interest_count();


alter table public.idea_interest enable row level security;

-- The message is between the interested party and the author. Other visitors
-- see the count, not the contents -- so the count is public information but the
-- pitch is not.
create policy idea_interest_select_self
  on public.idea_interest for select
  to authenticated
  using (profile_id = auth.uid());

create policy idea_interest_select_author
  on public.idea_interest for select
  to authenticated
  using (
    exists (select 1 from public.ideas i
             where i.id = idea_id and i.author_id = auth.uid())
  );

create policy idea_interest_select_moderator
  on public.idea_interest for select
  to authenticated
  using (app.is_moderator());

create policy idea_interest_insert_self
  on public.idea_interest for insert
  to authenticated
  with check (profile_id = auth.uid() and app.can_view_idea(idea_id));

create policy idea_interest_delete
  on public.idea_interest for delete
  to authenticated
  using (
    profile_id = auth.uid()
    or exists (select 1 from public.ideas i
                where i.id = idea_id and i.author_id = auth.uid())
  );

revoke all on table public.idea_interest from anon, authenticated;
grant select on table public.idea_interest to authenticated;
grant insert, delete on table public.idea_interest to authenticated;


-- =============================================================================
-- idea_comments
--
-- Flat, not threaded. An idea discussion is short by nature; a reply tree would
-- add depth-management code for no benefit at this scale.
-- =============================================================================

create table public.idea_comments (
  id        uuid primary key default gen_random_uuid(),
  idea_id   uuid not null references public.ideas (id)    on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,

  body text not null check (length(btrim(body)) between 1 and 2000),

  is_edited boolean not null default false,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index idea_comments_idea_idx
  on public.idea_comments (idea_id, created_at, id)
  where deleted_at is null and moderation_status = 'active';

create index idea_comments_author_idx
  on public.idea_comments (author_id, created_at desc);


create or replace function app.idea_comments_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.author_id         := auth.uid();
    new.moderation_status := 'active';
    new.deleted_at        := null;
  end if;

  if tg_op = 'UPDATE'
     and new.body is distinct from old.body
     and not app.is_privileged_role()
  then
    new.is_edited := true;
  end if;

  return new;
end;
$$;

create trigger idea_comments_before_write
  before insert or update on public.idea_comments
  for each row execute function app.idea_comments_before_write();

create trigger idea_comments_set_updated_at
  before update on public.idea_comments
  for each row execute function app.set_updated_at();

create trigger idea_comments_protect_columns
  before update on public.idea_comments
  for each row execute function app.reject_protected_column_change(
    'idea_id', 'author_id', 'created_at'
  );


create or replace function app.sync_idea_comment_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_live boolean := (tg_op <> 'INSERT'
                         and old.deleted_at is null
                         and old.moderation_status = 'active');
  v_is_live boolean := (tg_op <> 'DELETE'
                        and new.deleted_at is null
                        and new.moderation_status = 'active');
begin
  if v_was_live = v_is_live then
    return null;
  end if;

  if v_is_live then
    update public.ideas set comment_count = comment_count + 1
     where id = new.idea_id;
  else
    update public.ideas set comment_count = greatest(0, comment_count - 1)
     where id = old.idea_id;
  end if;

  return null;
end;
$$;

create trigger idea_comments_sync_count
  after insert or update or delete on public.idea_comments
  for each row execute function app.sync_idea_comment_count();


alter table public.idea_comments enable row level security;

create policy idea_comments_select
  on public.idea_comments for select
  to anon, authenticated
  using (
    app.can_view_idea(idea_id)
    and (
      (deleted_at is null and moderation_status = 'active')
      or author_id = auth.uid()
      or app.is_moderator()
    )
  );

create policy idea_comments_insert_own
  on public.idea_comments for insert
  to authenticated
  with check (author_id = auth.uid() and app.can_view_idea(idea_id));

create policy idea_comments_update_own
  on public.idea_comments for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy idea_comments_update_moderator
  on public.idea_comments for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

-- The idea's author may remove comments on their own idea, as on a post.
create policy idea_comments_delete
  on public.idea_comments for delete
  to authenticated
  using (
    author_id = auth.uid()
    or app.is_moderator()
    or exists (select 1 from public.ideas i
                where i.id = idea_id and i.author_id = auth.uid())
  );

revoke all on table public.idea_comments from anon, authenticated;
grant select on table public.idea_comments to anon, authenticated;
grant insert on table public.idea_comments to authenticated;
grant update (body, deleted_at, updated_at)
  on table public.idea_comments to authenticated;
grant delete on table public.idea_comments to authenticated;


-- =============================================================================
-- Function grants
-- =============================================================================

revoke execute on function app.can_view_idea(uuid) from public;
grant execute on function app.can_view_idea(uuid)
  to anon, authenticated, service_role;

revoke execute on function app.ideas_before_write()           from public;
revoke execute on function app.idea_votes_before_insert()     from public;
revoke execute on function app.sync_idea_vote_count()         from public;
revoke execute on function app.idea_interest_before_insert()  from public;
revoke execute on function app.sync_idea_interest_count()     from public;
revoke execute on function app.idea_comments_before_write()   from public;
revoke execute on function app.sync_idea_comment_count()      from public;
