-- =============================================================================
-- 0013  Opportunities and events
-- =============================================================================
-- Two boards that answer the fifth product question -- "what should I do next?"
-- Opportunities are things to apply for; events are things to turn up to. Both
-- are time-bounded, which is what makes them useful on a dashboard and what
-- makes them different from a post.
--
-- WHERE THE DATA COMES FROM
-- -------------------------
-- Every row is submitted by a signed-in member of this platform. Nothing here
-- ingests listings from anywhere else, and `source` carries a CHECK constraint
-- that permits exactly one value ('user_submitted') so that the database itself
-- refuses a row from an unvetted pipeline. Widening that constraint is a
-- deliberate migration, and the only acceptable reason to write one is an
-- official API or an explicit licence from the source -- never a scraper.
--
-- This is not a stylistic preference. Scraping a job board or a university
-- events page to populate this table would breach those sites' terms, and a
-- constraint is a better record of that decision than a comment alone.
--
-- WHAT IS NOT COUNTED
-- -------------------
-- There is no view_count and no click_count on either table. A view is not
-- something this schema can observe honestly -- a client-incremented counter is
-- a number the client chose -- so it is absent rather than approximated.
-- save_count and attendee_count exist because they are exact counts of rows in
-- opportunity_saves and event_attendees, maintained by trigger.
--
-- MODERATION
-- ----------
-- Both tables mirror the posts model: `moderation_status` defaults to 'active'
-- and is lowered by moderator action, rather than requiring approval before a
-- listing appears. Pre-moderation would mean an empty board for as long as no
-- moderator is awake, and the honest tradeoff for a student network is
-- report-driven takedown. 0015 adds the reporting path.
-- =============================================================================


-- =============================================================================
-- opportunities
-- =============================================================================

create table public.opportunities (
  id       uuid primary key default gen_random_uuid(),
  slug     text not null,

  posted_by uuid not null references public.profiles (id) on delete cascade,

  title        text not null check (length(btrim(title)) between 3 and 160),
  organisation text not null check (length(btrim(organisation)) between 1 and 160),
  description  text not null check (length(btrim(description)) between 20 and 10000),

  type text not null
       check (type in ('internship', 'part_time', 'full_time', 'research',
                       'thesis', 'scholarship', 'competition', 'volunteer',
                       'other')),

  -- Free text, deliberately not a number. "€1,200/month", "unpaid",
  -- "stipend, amount TBC" are all honest; a numeric salary field invites a
  -- guess, and a guess about pay is worse than no answer.
  compensation text check (length(compensation) <= 120),

  work_mode text not null default 'onsite'
            check (work_mode in ('onsite', 'hybrid', 'remote')),
  location  text check (length(location) <= 160),

  -- At least one route to apply must exist, or the listing wastes the reader's
  -- time. Checked by the constraint below rather than by the form alone.
  apply_url   text check (apply_url is null or apply_url ~* '^https?://'),
  apply_email text check (apply_email is null or apply_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  deadline date,
  starts_on date,

  -- Which university's board this appears on. Denormalised from the poster's
  -- profile by trigger, like posts.university_id.
  university_id uuid references public.universities (id) on delete set null,

  visibility text not null default 'public'
             check (visibility in ('public', 'university')),

  status text not null default 'open'
         check (status in ('open', 'closed', 'filled')),

  source text not null default 'user_submitted'
         check (source in ('user_submitted')),

  save_count integer not null default 0,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint opportunities_slug_key unique (slug),
  constraint opportunities_has_apply_route check (
    apply_url is not null or apply_email is not null
  ),
  constraint opportunities_dates_ordered check (
    deadline is null or starts_on is null or deadline <= starts_on
  )
);

comment on table public.opportunities is
  'Member-submitted openings. `source` is constrained to user_submitted so no
   scraped or unlicensed feed can be inserted without a deliberate migration.';
comment on column public.opportunities.compensation is
  'Free text on purpose. A numeric pay field would be filled in with guesses.';

-- The board: open, undeleted, soonest deadline first. Rows with no deadline sort
-- last, which is right -- a dated opportunity is more urgent than an open one.
create index opportunities_board_idx
  on public.opportunities (deadline nulls last, created_at desc)
  where deleted_at is null and moderation_status = 'active' and status = 'open';

create index opportunities_university_idx
  on public.opportunities (university_id, deadline nulls last)
  where deleted_at is null and moderation_status = 'active';

create index opportunities_poster_idx
  on public.opportunities (posted_by, created_at desc);

create index opportunities_type_idx
  on public.opportunities (type, deadline nulls last)
  where deleted_at is null and moderation_status = 'active' and status = 'open';

create index opportunities_title_trgm_idx
  on public.opportunities using gin (title extensions.gin_trgm_ops);

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function app.set_updated_at();


create or replace function app.opportunities_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_poster_visibility text;
  v_poster_university uuid;
begin
  new.title        := btrim(new.title);
  new.organisation := btrim(new.organisation);
  new.apply_email  := lower(nullif(btrim(new.apply_email), ''));
  new.apply_url    := nullif(btrim(new.apply_url), '');

  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.posted_by         := auth.uid();
      new.save_count        := 0;
      new.moderation_status := 'active';
      new.deleted_at        := null;
      -- The only permitted provenance. Restated here so a forged value on the
      -- insert is overwritten rather than merely rejected.
      new.source            := 'user_submitted';
    end if;

    new.slug := app.unique_slug('opportunities', 'slug', app.slugify(new.title));
  end if;

  select p.visibility, p.university_id
    into v_poster_visibility, v_poster_university
    from public.profiles p
   where p.id = new.posted_by;

  new.university_id := v_poster_university;

  -- A university-scoped listing on a profile with no university would be
  -- invisible to everyone including its author, which reads as a bug. Fall back
  -- to the open board.
  if new.visibility = 'university' and v_poster_university is null then
    new.visibility := 'public';
  end if;

  -- Unlike posts, an opportunity is not clamped to the poster's profile
  -- visibility. A student who keeps their own profile private may still want to
  -- tell the university about an internship, and the listing is about the
  -- employer rather than about them.
  if new.visibility not in ('public', 'university') then
    new.visibility := 'public';
  end if;

  return new;
end;
$$;

revoke execute on function app.opportunities_before_write() from public;

create trigger opportunities_before_write
  before insert or update on public.opportunities
  for each row execute function app.opportunities_before_write();

create trigger opportunities_protect_columns
  before update on public.opportunities
  for each row execute function app.reject_protected_column_change(
    'id', 'slug', 'posted_by', 'created_at', 'save_count', 'source'
  );


-- -----------------------------------------------------------------------------
-- app.can_view_opportunity(uuid)
-- -----------------------------------------------------------------------------
create or replace function app.can_view_opportunity(v_opportunity_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_poster     uuid;
  v_visibility text;
  v_university uuid;
  v_deleted    timestamptz;
  v_moderation text;
  v_viewer     uuid := auth.uid();
begin
  select o.posted_by, o.visibility, o.university_id, o.deleted_at,
         o.moderation_status
    into v_poster, v_visibility, v_university, v_deleted, v_moderation
    from public.opportunities o
   where o.id = v_opportunity_id;

  if v_poster is null then
    return false;
  end if;

  if v_viewer = v_poster or app.is_moderator(v_viewer) then
    return true;
  end if;

  if v_deleted is not null or v_moderation <> 'active' then
    return false;
  end if;

  if v_viewer is not null and app.is_blocked_either_way(v_viewer, v_poster) then
    return false;
  end if;

  return case v_visibility
    when 'public' then true
    when 'university' then v_viewer is not null
                           and v_university is not null
                           and exists (
                             select 1 from public.profiles vp
                              where vp.id = v_viewer
                                and vp.university_id = v_university
                           )
    else false
  end;
end;
$$;

revoke execute on function app.can_view_opportunity(uuid) from public;
grant execute on function app.can_view_opportunity(uuid) to anon, authenticated, service_role;


alter table public.opportunities enable row level security;

-- Written inline rather than as can_view_opportunity(id) so the planner can use
-- the partial indexes above instead of calling a function per row.
create policy opportunities_select
  on public.opportunities for select
  to anon, authenticated
  using (
    posted_by = auth.uid()
    or app.is_moderator()
    or (
      deleted_at is null
      and moderation_status = 'active'
      and not app.is_blocked_either_way(auth.uid(), posted_by)
      and (
        visibility = 'public'
        or (
          visibility = 'university'
          and university_id is not null
          and exists (
            select 1 from public.profiles vp
             where vp.id = auth.uid() and vp.university_id = opportunities.university_id
          )
        )
      )
    )
  );

create policy opportunities_insert_own
  on public.opportunities for insert
  to authenticated
  with check (posted_by = auth.uid());

create policy opportunities_update_own
  on public.opportunities for update
  to authenticated
  using (posted_by = auth.uid())
  with check (posted_by = auth.uid());

create policy opportunities_update_moderator
  on public.opportunities for update
  to authenticated
  using (app.is_moderator()) with check (app.is_moderator());

create policy opportunities_delete_own
  on public.opportunities for delete
  to authenticated
  using (posted_by = auth.uid() or app.is_admin());

revoke all on table public.opportunities from anon, authenticated;
grant select on table public.opportunities to anon, authenticated;
grant insert on table public.opportunities to authenticated;
grant update (title, organisation, description, type, compensation, work_mode,
              location, apply_url, apply_email, deadline, starts_on, visibility,
              status, moderation_status, university_id, updated_at, deleted_at)
  on table public.opportunities to authenticated;
grant delete on table public.opportunities to authenticated;


-- =============================================================================
-- opportunity_skills
--
-- The machine-readable half of "who we are looking for", so the board can be
-- filtered against a student's declared skills instead of by keyword alone.
-- =============================================================================

create table public.opportunity_skills (
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  skill_id       uuid not null references public.skills (id)        on delete cascade,

  is_required boolean not null default false,
  created_at  timestamptz not null default now(),

  primary key (opportunity_id, skill_id)
);

create index opportunity_skills_skill_idx
  on public.opportunity_skills (skill_id) where is_required;

alter table public.opportunity_skills enable row level security;

create policy opportunity_skills_select
  on public.opportunity_skills for select
  to anon, authenticated
  using (app.can_view_opportunity(opportunity_id));

create policy opportunity_skills_write_own
  on public.opportunity_skills for all
  to authenticated
  using (
    exists (
      select 1 from public.opportunities o
       where o.id = opportunity_skills.opportunity_id and o.posted_by = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.opportunities o
       where o.id = opportunity_skills.opportunity_id and o.posted_by = auth.uid()
    )
  );

revoke all on table public.opportunity_skills from anon, authenticated;
grant select on table public.opportunity_skills to anon, authenticated;
grant insert, update, delete on table public.opportunity_skills to authenticated;


-- =============================================================================
-- opportunity_saves
--
-- A private bookmark. Nobody but the saver can see who saved what -- the poster
-- included. Interest in a job is not something to publish about a student.
-- =============================================================================

create table public.opportunity_saves (
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  profile_id     uuid not null references public.profiles (id)      on delete cascade,

  -- The student's own note to self ("ask Dr. Weber for a reference"). Private
  -- for the same reason the row is.
  note text check (length(note) <= 500),

  created_at timestamptz not null default now(),

  primary key (opportunity_id, profile_id)
);

comment on table public.opportunity_saves is
  'Private bookmarks. Readable only by the saver -- not by the poster, who would
   otherwise learn who is considering applying.';

create index opportunity_saves_profile_idx
  on public.opportunity_saves (profile_id, created_at desc);


create or replace function app.sync_opportunity_save_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.opportunities
       set save_count = save_count + 1
     where id = new.opportunity_id;
  elsif tg_op = 'DELETE' then
    update public.opportunities
       set save_count = greatest(save_count - 1, 0)
     where id = old.opportunity_id;
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_opportunity_save_count() from public;

create trigger opportunity_saves_sync_count
  after insert or delete on public.opportunity_saves
  for each row execute function app.sync_opportunity_save_count();


create or replace function app.opportunity_saves_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  if not app.can_view_opportunity(new.opportunity_id) then
    raise exception 'Opportunity not found'
      using errcode = '42501', hint = 'opportunity_not_visible';
  end if;

  return new;
end;
$$;

revoke execute on function app.opportunity_saves_before_insert() from public;

create trigger opportunity_saves_before_insert
  before insert on public.opportunity_saves
  for each row execute function app.opportunity_saves_before_insert();

alter table public.opportunity_saves enable row level security;

create policy opportunity_saves_own
  on public.opportunity_saves for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.opportunity_saves from anon, authenticated;
grant select, insert, delete on table public.opportunity_saves to authenticated;
grant update (note) on table public.opportunity_saves to authenticated;


-- =============================================================================
-- events
--
-- TIME ZONES
-- ----------
-- starts_at and ends_at are timestamptz, so they denote a real instant. But an
-- organiser thinking "the workshop is at 14:00" means 14:00 somewhere, and if
-- the reader is elsewhere the app has to be able to say both. `time_zone` stores
-- the organiser's IANA zone for exactly that, validated against
-- pg_timezone_names by trigger -- a CHECK cannot do it, because looking a zone
-- up is not immutable.
-- =============================================================================

create table public.events (
  id   uuid primary key default gen_random_uuid(),
  slug text not null,

  created_by uuid not null references public.profiles (id) on delete cascade,

  title       text not null check (length(btrim(title)) between 3 and 160),
  description text check (length(description) <= 10000),

  type text not null default 'other'
       check (type in ('workshop', 'hackathon', 'meetup', 'talk', 'competition',
                       'study_group', 'deadline', 'social', 'other')),

  starts_at timestamptz not null,
  ends_at   timestamptz,
  time_zone text not null default 'UTC',
  is_all_day boolean not null default false,

  attendance_mode text not null default 'onsite'
                  check (attendance_mode in ('onsite', 'online', 'hybrid')),
  location     text check (length(location) <= 200),
  location_url text check (location_url is null or location_url ~* '^https?://'),
  join_url     text check (join_url is null or join_url ~* '^https?://'),

  -- An event can belong to a project ("Orbit design review"), which is what puts
  -- it on that project's page rather than only on the campus calendar.
  project_id uuid references public.projects (id) on delete cascade,

  university_id uuid references public.universities (id) on delete set null,

  visibility text not null default 'public'
             check (visibility in ('public', 'university', 'connections', 'private')),

  -- NULL means "no limit". Enforced in the RSVP trigger, under a row lock on
  -- this row, so two simultaneous RSVPs cannot both take the last place.
  capacity integer check (capacity is null or capacity between 1 and 100000),

  -- Exact count of event_attendees rows with status 'going'.
  attendee_count    integer not null default 0,
  interested_count  integer not null default 0,

  status text not null default 'scheduled'
         check (status in ('scheduled', 'cancelled', 'completed')),

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint events_slug_key unique (slug),
  constraint events_span_ordered check (ends_at is null or ends_at >= starts_at),
  -- An online or hybrid event needs somewhere to join; an onsite one needs a
  -- place. Neither is checkable for hybrid without picking one, so the rule is
  -- the weaker "online events must say where".
  constraint events_online_has_url check (
    attendance_mode <> 'online' or join_url is not null or location_url is not null
  )
);

comment on table public.events is
  'Campus and project calendar. starts_at is an instant; time_zone records the
   organiser''s intended local time for display.';

create index events_calendar_idx
  on public.events (starts_at)
  where deleted_at is null and moderation_status = 'active' and status <> 'cancelled';

create index events_university_idx
  on public.events (university_id, starts_at)
  where deleted_at is null and moderation_status = 'active';

create index events_project_idx
  on public.events (project_id, starts_at) where project_id is not null;

create index events_creator_idx on public.events (created_by, starts_at desc);

create index events_title_trgm_idx
  on public.events using gin (title extensions.gin_trgm_ops);

create trigger events_set_updated_at
  before update on public.events
  for each row execute function app.set_updated_at();


create or replace function app.events_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_visibility text;
  v_creator_university uuid;
  v_project_visibility text;
begin
  new.title := btrim(new.title);

  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.created_by        := auth.uid();
      new.attendee_count    := 0;
      new.interested_count  := 0;
      new.moderation_status := 'active';
      new.deleted_at        := null;
    end if;

    new.slug := app.unique_slug('events', 'slug', app.slugify(new.title));
  end if;

  -- A zone the database cannot resolve would silently render as UTC later, so
  -- reject it now while the organiser is still looking at the form.
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone
  ) then
    raise exception 'Unknown time zone: %', new.time_zone
      using errcode = '22023', hint = 'unknown_time_zone';
  end if;

  select p.visibility, p.university_id
    into v_creator_visibility, v_creator_university
    from public.profiles p
   where p.id = new.created_by;

  new.university_id := v_creator_university;

  if new.project_id is not null then
    -- Only a member may put an event on a project, and the event can never be
    -- more visible than the project it belongs to -- otherwise a private
    -- project's schedule leaks its existence.
    if not app.is_project_member(new.project_id, new.created_by)
       and not app.is_privileged_role()
    then
      raise exception 'You are not a member of that project'
        using errcode = '42501', hint = 'project_not_member';
    end if;

    select pr.visibility into v_project_visibility
      from public.projects pr where pr.id = new.project_id;

    new.visibility := app.clamp_visibility(new.visibility,
                                           coalesce(v_project_visibility, 'private'));
  else
    new.visibility := app.clamp_visibility(new.visibility,
                                           coalesce(v_creator_visibility, 'private'));
  end if;

  return new;
end;
$$;

revoke execute on function app.events_before_write() from public;

create trigger events_before_write
  before insert or update on public.events
  for each row execute function app.events_before_write();

create trigger events_protect_columns
  before update on public.events
  for each row execute function app.reject_protected_column_change(
    'id', 'slug', 'created_by', 'created_at', 'attendee_count', 'interested_count'
  );


-- -----------------------------------------------------------------------------
-- app.can_view_event(uuid)
-- -----------------------------------------------------------------------------
create or replace function app.can_view_event(v_event_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_creator    uuid;
  v_visibility text;
  v_university uuid;
  v_project    uuid;
  v_deleted    timestamptz;
  v_moderation text;
  v_viewer     uuid := auth.uid();
begin
  select e.created_by, e.visibility, e.university_id, e.project_id, e.deleted_at,
         e.moderation_status
    into v_creator, v_visibility, v_university, v_project, v_deleted, v_moderation
    from public.events e
   where e.id = v_event_id;

  if v_creator is null then
    return false;
  end if;

  if v_viewer = v_creator or app.is_moderator(v_viewer) then
    return true;
  end if;

  if v_deleted is not null or v_moderation <> 'active' then
    return false;
  end if;

  if v_viewer is not null and app.is_blocked_either_way(v_viewer, v_creator) then
    return false;
  end if;

  -- A project event is visible to the project's members whatever its own
  -- visibility, so a private project's team can still see its own schedule.
  if v_project is not null and v_viewer is not null
     and app.is_project_member(v_project, v_viewer)
  then
    return true;
  end if;

  return case v_visibility
    when 'public' then true
    when 'university' then v_viewer is not null
                           and v_university is not null
                           and exists (
                             select 1 from public.profiles vp
                              where vp.id = v_viewer
                                and vp.university_id = v_university
                           )
    when 'connections' then v_viewer is not null
                            and app.are_connected(v_viewer, v_creator)
    else false
  end;
end;
$$;

revoke execute on function app.can_view_event(uuid) from public;
grant execute on function app.can_view_event(uuid) to anon, authenticated, service_role;


alter table public.events enable row level security;

create policy events_select
  on public.events for select
  to anon, authenticated
  using (
    created_by = auth.uid()
    or app.is_moderator()
    or (
      deleted_at is null
      and moderation_status = 'active'
      and not app.is_blocked_either_way(auth.uid(), created_by)
      and (
        (project_id is not null and app.is_project_member(project_id, auth.uid()))
        or visibility = 'public'
        or (
          visibility = 'university'
          and university_id is not null
          and exists (
            select 1 from public.profiles vp
             where vp.id = auth.uid() and vp.university_id = events.university_id
          )
        )
        or (visibility = 'connections' and app.are_connected(auth.uid(), created_by))
      )
    )
  );

create policy events_insert_own
  on public.events for insert
  to authenticated
  with check (created_by = auth.uid());

create policy events_update_own
  on public.events for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

create policy events_update_moderator
  on public.events for update
  to authenticated
  using (app.is_moderator()) with check (app.is_moderator());

create policy events_delete_own
  on public.events for delete
  to authenticated
  using (created_by = auth.uid() or app.is_admin());

revoke all on table public.events from anon, authenticated;
grant select on table public.events to anon, authenticated;
grant insert on table public.events to authenticated;
grant update (title, description, type, starts_at, ends_at, time_zone, is_all_day,
              attendance_mode, location, location_url, join_url, project_id,
              visibility, capacity, status, moderation_status, university_id,
              updated_at, deleted_at)
  on table public.events to authenticated;
grant delete on table public.events to authenticated;


-- =============================================================================
-- event_attendees
--
-- WHY THE CAPACITY CHECK TAKES A ROW LOCK
-- ---------------------------------------
-- "Count the going rows, compare to capacity" is wrong under concurrency: two
-- transactions each counting 29 of 30 both insert, and the event is oversubscribed
-- with no error anywhere. The trigger therefore locks the events row first, which
-- serialises RSVPs for that one event and nothing else. Locks are always taken on
-- events before event_attendees, so there is no lock-ordering cycle.
-- =============================================================================

create table public.event_attendees (
  event_id   uuid not null references public.events (id)   on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,

  status text not null default 'going'
         check (status in ('going', 'interested', 'not_going')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (event_id, profile_id)
);

comment on table public.event_attendees is
  'RSVPs. Visible to anyone who can see the event, because turning up to a public
   event is a public act -- but see the note on private events in the policy.';

create index event_attendees_profile_idx
  on public.event_attendees (profile_id, created_at desc);

create trigger event_attendees_set_updated_at
  before update on public.event_attendees
  for each row execute function app.set_updated_at();


create or replace function app.event_attendees_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_status   text;
  v_going    integer;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  if not app.can_view_event(new.event_id) then
    raise exception 'Event not found'
      using errcode = '42501', hint = 'event_not_visible';
  end if;

  -- Only 'going' consumes a place, so only that transition needs the lock.
  if new.status = 'going'
     and (tg_op = 'INSERT' or old.status is distinct from 'going')
  then
    select e.capacity, e.status into v_capacity, v_status
      from public.events e
     where e.id = new.event_id
       for update;

    if v_status = 'cancelled' then
      raise exception 'That event has been cancelled'
        using errcode = '42501', hint = 'event_cancelled';
    end if;

    if v_capacity is not null then
      select count(*) into v_going
        from public.event_attendees a
       where a.event_id = new.event_id
         and a.status = 'going'
         and a.profile_id <> new.profile_id;

      if v_going >= v_capacity then
        raise exception 'That event is full'
          using errcode = '23514', hint = 'event_full';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function app.event_attendees_before_write() from public;

create trigger event_attendees_before_write
  before insert or update on public.event_attendees
  for each row execute function app.event_attendees_before_write();


create or replace function app.sync_event_attendee_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
begin
  -- Recomputed rather than incremented. A status change is three cases
  -- (going→interested, interested→going, going→not_going) and an increment for
  -- each is three chances to drift; one count cannot drift at all.
  update public.events e
     set attendee_count = (
           select count(*) from public.event_attendees a
            where a.event_id = v_event and a.status = 'going'
         ),
         interested_count = (
           select count(*) from public.event_attendees a
            where a.event_id = v_event and a.status = 'interested'
         )
   where e.id = v_event;

  return null;
end;
$$;

revoke execute on function app.sync_event_attendee_counts() from public;

create trigger event_attendees_sync_counts
  after insert or update of status or delete on public.event_attendees
  for each row execute function app.sync_event_attendee_counts();


alter table public.event_attendees enable row level security;

-- Own RSVP always readable. Others' RSVPs readable when the event itself is
-- readable -- an attendee list is part of what a public event is. A student who
-- does not want that can mark 'interested' instead, which the UI must present as
-- the quieter option.
create policy event_attendees_select
  on public.event_attendees for select
  to anon, authenticated
  using (profile_id = auth.uid() or app.can_view_event(event_id));

create policy event_attendees_write_own
  on public.event_attendees for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- The organiser may remove someone from their own event.
create policy event_attendees_delete_organiser
  on public.event_attendees for delete
  to authenticated
  using (
    exists (
      select 1 from public.events e
       where e.id = event_attendees.event_id and e.created_by = auth.uid()
    )
  );

revoke all on table public.event_attendees from anon, authenticated;
grant select, insert, delete on table public.event_attendees to authenticated;
grant update (status, updated_at) on table public.event_attendees to authenticated;

create trigger event_attendees_protect_columns
  before update on public.event_attendees
  for each row execute function app.reject_protected_column_change(
    'event_id', 'profile_id', 'created_at'
  );


-- =============================================================================
-- posts.opportunity_id — foreign key and anchor validation
--
-- 0008 declared the column as bare text-less uuid with no reference, for the same
-- reason as goal_id and achievement_key: the target table did not exist yet.
-- =============================================================================

alter table public.posts
  add constraint posts_opportunity_id_fkey
  foreign key (opportunity_id)
  references public.opportunities (id) on delete set null;

create index posts_opportunity_idx on public.posts (opportunity_id)
  where opportunity_id is not null;


create or replace function app.posts_opportunity_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_visibility text;
begin
  if new.opportunity_id is null then
    return new;
  end if;

  -- Anyone who can see an opportunity may share it -- unlike goals and
  -- achievements, this is not a claim about the author. But you cannot share one
  -- you cannot see, because the post would be an oracle for hidden listings.
  if not app.can_view_opportunity(new.opportunity_id) then
    raise exception 'Opportunity not found'
      using errcode = '42501', hint = 'opportunity_not_visible';
  end if;

  select o.visibility into v_visibility
    from public.opportunities o where o.id = new.opportunity_id;

  -- A post about a university-only listing must not be public. As with goals,
  -- this clamps on write; lowering an opportunity's visibility later does not
  -- retroactively rewrite posts that already exist (see docs/DATABASE.md).
  new.visibility := app.clamp_visibility(new.visibility, coalesce(v_visibility, 'private'));

  return new;
end;
$$;

revoke execute on function app.posts_opportunity_anchor() from public;

-- After posts_before_write ('b' < 'c'), which forces author_id and applies the
-- profile-visibility clamp this one then narrows further.
create trigger posts_check_opportunity
  before insert or update on public.posts
  for each row execute function app.posts_opportunity_anchor();
