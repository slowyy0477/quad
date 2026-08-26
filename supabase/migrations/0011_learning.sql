-- =============================================================================
-- 0011  Learning trackers — semesters, courses, goals, study sessions, daily logs
-- =============================================================================
-- The private half of the product. Everything a student records about their own
-- studying lives here, and almost none of it is meant to be seen by anyone else.
--
-- WHAT IS PRIVATE AND WHY
-- -----------------------
-- semesters, courses, study_sessions and daily_logs are OWNER-ONLY. There is no
-- visibility column on them, because there is no sharing story for them:
--
--   * courses carries a grade. A grade is one of the few facts on this platform
--     that can materially damage someone if it leaks — scholarships, visas,
--     internships and family relationships all turn on it. It is readable by
--     exactly one account, and deliberately not by moderators either. A
--     moderator who needs to act on a course row does not exist as a use case;
--     a moderator who can browse everyone's transcript is a breach waiting for
--     an excuse.
--
--   * daily_logs is a journal. "How did today go" answered honestly is a mental
--     health record in everything but name.
--
--   * study_sessions is a minute-by-minute record of when someone was at their
--     desk. Published, it is a presence tracker.
--
-- goals ARE shareable, because a shared goal is the thing the feed is for:
-- "learning React by March" is a post worth making, and other students
-- answering it is the point of the site. So goals carry the same four-level
-- `visibility` column as posts and projects, clamped by the same rule.
--
-- SELF-REPORTED, AND SAID SO
-- --------------------------
-- Nothing in this file measures anything. current_value on a goal is a number
-- the user typed; duration_minutes on a session is a number the user typed. The
-- schema does not pretend otherwise, and neither should the UI: no badge here
-- may be worded as though the platform verified it. The one derived value,
-- goals.progress_percent, is a GENERATED column precisely so that it cannot be
-- claimed independently of the numbers it comes from — and it floors rather
-- than rounds, so 99.6% of a target is not displayed as done.
--
-- posts.goal_id
-- -------------
-- The column already exists in 0008 as a bare uuid (posts is created before
-- goals, so the reference could not be declared there). This migration adds the
-- foreign key and the trigger that (a) requires the goal to be the post
-- author's own and (b) clamps the post's visibility to the goal's, so a public
-- "learning update" cannot render the title of a private goal.
-- =============================================================================


-- =============================================================================
-- semesters
--
-- A container for courses and a date range for "what am I doing right now".
-- One row may be flagged is_current per profile; the flag is exclusive, and the
-- exclusion is a unique index rather than an application convention.
-- =============================================================================

create table public.semesters (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  name text not null check (length(btrim(name)) between 1 and 80),

  term text check (term in ('fall', 'spring', 'summer', 'winter', 'other')),
  year integer check (year between 1950 and 2100),

  start_date date,
  end_date   date,

  is_current boolean not null default false,

  notes text check (length(notes) <= 2000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint semesters_dates_ordered
    check (start_date is null or end_date is null or end_date >= start_date)
);

comment on table public.semesters is
  'Academic terms, private to the owning profile. No visibility column: see the
   file header.';

-- Exactly one current semester per profile. The BEFORE trigger below clears the
-- previous one, so setting a new current semester is a single UPDATE from the
-- client rather than a two-statement dance it could get half-way through.
create unique index semesters_one_current_key
  on public.semesters (profile_id) where is_current;

create index semesters_profile_idx
  on public.semesters (profile_id, start_date desc nulls last);

create trigger semesters_set_updated_at
  before update on public.semesters
  for each row execute function app.set_updated_at();


create or replace function app.semesters_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  -- Demote the outgoing current semester before this row lands, so the partial
  -- unique index is never transiently violated. The recursive UPDATE re-enters
  -- this function at trigger depth 2 with is_current = false, which cannot
  -- recurse again.
  if new.is_current
     and (tg_op = 'INSERT' or not old.is_current)
  then
    update public.semesters
       set is_current = false
     where profile_id = new.profile_id
       and is_current
       and id <> new.id;
  end if;

  return new;
end;
$$;

revoke execute on function app.semesters_before_write() from public;

create trigger semesters_before_write
  before insert or update on public.semesters
  for each row execute function app.semesters_before_write();

create trigger semesters_protect_columns
  before update on public.semesters
  for each row execute function app.reject_protected_column_change(
    'id', 'profile_id', 'created_at'
  );


alter table public.semesters enable row level security;

create policy semesters_own
  on public.semesters for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.semesters from anon, authenticated;
grant select on table public.semesters to authenticated;
grant insert on table public.semesters to authenticated;
grant update (name, term, year, start_date, end_date, is_current, notes, updated_at)
  on table public.semesters to authenticated;
grant delete on table public.semesters to authenticated;


-- =============================================================================
-- courses
--
-- An enrolment record, not a catalogue entry. Two students taking the same
-- module each own their own row: the grade, the credit weighting and the
-- instructor name are all things one student may record and another may not.
--
-- `grade` is free text, and there is deliberately no GPA anywhere in this
-- schema. Grading systems are not comparable across (or often within)
-- countries — 1.0 is the best possible mark in Germany and a failing one in the
-- US, and a 2:1 is neither. A computed "GPA" would be a number the platform
-- invented, presented as though the university had issued it.
-- =============================================================================

create table public.courses (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  semester_id uuid references public.semesters (id) on delete set null,

  code  text check (length(btrim(code)) between 1 and 32),
  title text not null check (length(btrim(title)) between 1 and 160),

  instructor text check (length(instructor) <= 120),
  credits    numeric(4, 1) check (credits >= 0 and credits <= 60),

  status text not null default 'in_progress'
         check (status in ('planned', 'in_progress', 'completed', 'dropped')),

  -- Recorded verbatim, never parsed or aggregated. See the table note above.
  grade text check (length(btrim(grade)) <= 20),

  -- Optional per-course accent used in the planner UI. Constrained to a hex
  -- triple so it can be interpolated into a style attribute without becoming an
  -- injection point.
  color text check (color ~ '^#[0-9A-Fa-f]{6}$'),

  notes text check (length(notes) <= 2000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.courses.grade is
  'Free text, as issued by the institution. Never parsed, compared or averaged.';

-- One row per course code per term. NULLS NOT DISTINCT so that two unfiled
-- courses (semester_id is null) with the same code still collide.
create unique index courses_profile_code_key
  on public.courses (profile_id, semester_id, lower(code))
  nulls not distinct
  where code is not null;

create index courses_profile_idx  on public.courses (profile_id, status);
create index courses_semester_idx on public.courses (semester_id);

create trigger courses_set_updated_at
  before update on public.courses
  for each row execute function app.set_updated_at();


create or replace function app.courses_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  -- A course may only be filed under one of your own semesters. Without this,
  -- semester_id is an oracle: set it to someone else's id, then read your own
  -- course back and learn whether the write succeeded, i.e. whether that
  -- semester exists.
  if new.semester_id is not null
     and (tg_op = 'INSERT' or new.semester_id is distinct from old.semester_id)
  then
    select s.profile_id into v_owner
      from public.semesters s where s.id = new.semester_id;

    if v_owner is distinct from new.profile_id then
      raise exception 'That semester does not belong to you'
        using errcode = '42501', hint = 'semester_not_owned';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function app.courses_before_write() from public;

create trigger courses_before_write
  before insert or update on public.courses
  for each row execute function app.courses_before_write();

create trigger courses_protect_columns
  before update on public.courses
  for each row execute function app.reject_protected_column_change(
    'id', 'profile_id', 'created_at'
  );


alter table public.courses enable row level security;

-- Owner only, for every operation, with no moderator exception. See the header.
create policy courses_own
  on public.courses for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.courses from anon, authenticated;
grant select on table public.courses to authenticated;
grant insert on table public.courses to authenticated;
grant update (semester_id, code, title, instructor, credits, status, grade,
              color, notes, updated_at)
  on table public.courses to authenticated;
grant delete on table public.courses to authenticated;


-- =============================================================================
-- goals
--
-- The shareable tracker. A goal is a claim about intent ("read 12 papers this
-- term") plus a number the owner keeps up to date. Both halves are
-- user-declared; progress_percent is derived from them and cannot be set
-- directly.
-- =============================================================================

create table public.goals (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  title       text not null check (length(btrim(title)) between 1 and 160),
  description text check (length(description) <= 2000),

  category text not null default 'other'
           check (category in ('skill', 'course', 'project', 'career',
                               'habit', 'reading', 'fitness', 'other')),

  status text not null default 'active'
         check (status in ('active', 'paused', 'completed', 'abandoned')),

  -- Progress. `unit` is a label only ('papers', 'hours', 'chapters'); null
  -- means the numbers are a bare percentage.
  target_value  numeric(12, 2) not null default 100
                check (target_value > 0 and target_value <= 1000000),
  current_value numeric(12, 2) not null default 0
                check (current_value >= 0 and current_value <= 1000000),
  unit          text check (length(btrim(unit)) between 1 and 24),

  -- Derived, never granted, never trusted from the client. floor() and not
  -- round(): a goal is not shown as complete until it actually is.
  progress_percent integer
    generated always as (
      case
        when target_value <= 0                then null
        when current_value >= target_value    then 100
        when current_value <= 0               then 0
        else floor(current_value * 100 / target_value)::integer
      end
    ) stored,

  -- Optional anchors. A goal about a course or a project reads very differently
  -- from a free-floating one, and the tracker page groups by them.
  course_id   uuid references public.courses   (id) on delete set null,
  semester_id uuid references public.semesters (id) on delete set null,
  project_id  uuid references public.projects  (id) on delete set null,

  visibility text not null default 'private'
             check (visibility in ('public', 'university', 'connections', 'private')),

  start_date  date,
  target_date date,

  -- Set by trigger from `status`, so "completed" and "has a completion date"
  -- cannot disagree.
  completed_at timestamptz,

  milestone_count           integer not null default 0,
  completed_milestone_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint goals_dates_ordered
    check (start_date is null or target_date is null or target_date >= start_date)
);

comment on table public.goals is
  'Self-declared learning goals. Progress is reported by the owner; the platform
   measures nothing and must not be presented as if it did.';
comment on column public.goals.progress_percent is
  'Derived from current_value/target_value. Generated, so it cannot be set
   independently of the numbers it summarises.';
comment on column public.goals.visibility is
  'Clamped by trigger to the owner profile''s visibility, exactly as for posts
   and projects.';

create index goals_profile_idx on public.goals (profile_id, status, created_at desc);
create index goals_course_idx  on public.goals (course_id)   where course_id  is not null;
create index goals_project_idx on public.goals (project_id)  where project_id is not null;
create index goals_shared_idx  on public.goals (created_at desc)
  where visibility <> 'private';

create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function app.set_updated_at();


create or replace function app.goals_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_visibility text;
  v_owner            uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id               := auth.uid();
    new.milestone_count           := 0;
    new.completed_milestone_count := 0;
  end if;

  -- Same invariant as posts and projects: content cannot out-rank its author.
  select p.visibility into v_owner_visibility
    from public.profiles p where p.id = new.profile_id;

  new.visibility := app.clamp_visibility(new.visibility, coalesce(v_owner_visibility, 'private'));

  -- Anchors must be the caller's own rows. course_id and semester_id are
  -- owner-only tables, so a foreign id would otherwise be a probe; project_id
  -- requires membership for the same reason posts do — a goal rendered on a
  -- project page is a claim about that project.
  if new.course_id is not null
     and (tg_op = 'INSERT' or new.course_id is distinct from old.course_id)
  then
    select c.profile_id into v_owner
      from public.courses c where c.id = new.course_id;
    if v_owner is distinct from new.profile_id then
      raise exception 'That course does not belong to you'
        using errcode = '42501', hint = 'course_not_owned';
    end if;
  end if;

  if new.semester_id is not null
     and (tg_op = 'INSERT' or new.semester_id is distinct from old.semester_id)
  then
    select s.profile_id into v_owner
      from public.semesters s where s.id = new.semester_id;
    if v_owner is distinct from new.profile_id then
      raise exception 'That semester does not belong to you'
        using errcode = '42501', hint = 'semester_not_owned';
    end if;
  end if;

  if new.project_id is not null
     and not app.is_privileged_role()
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
  then
    if not app.is_project_member(new.project_id, new.profile_id) then
      raise exception 'You are not a member of that project'
        using errcode = '42501', hint = 'not_project_member';
    end if;
  end if;

  -- completed_at follows status, in both directions. Re-opening a goal clears
  -- the date rather than leaving a stale one behind.
  if new.status = 'completed' then
    if new.completed_at is null then
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;

  return new;
end;
$$;

revoke execute on function app.goals_before_write() from public;

create trigger goals_before_write
  before insert or update on public.goals
  for each row execute function app.goals_before_write();

-- completed_at is NOT listed. goals_before_write derives it from `status` on the
-- client's own statement, i.e. at trigger depth 1, so the protected-column guard
-- would see the schema's own change and reject a legitimate status update. What
-- keeps clients out of the column is the absence of an UPDATE grant on it; the
-- guard is the wrong tool for a value we rewrite ourselves on every write.
create trigger goals_protect_columns
  before update on public.goals
  for each row execute function app.reject_protected_column_change(
    'id', 'profile_id', 'created_at',
    'milestone_count', 'completed_milestone_count'
  );


-- -----------------------------------------------------------------------------
-- The single goal-visibility predicate, used by milestones and by the posts
-- anchor check. One definition, as with app.can_view_post.
-- -----------------------------------------------------------------------------
create or replace function app.can_view_goal(v_goal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.goals g
    where g.id = v_goal_id
      and (
        g.profile_id = auth.uid()
        or (
          g.visibility <> 'private'
          and app.can_view_profile(g.profile_id)
          and not app.is_blocked_either_way(g.profile_id, auth.uid())
          and (
            g.visibility = 'public'
            or (g.visibility = 'university'
                and app.share_university(g.profile_id, auth.uid()))
            or (g.visibility = 'connections'
                and app.are_connected(g.profile_id, auth.uid()))
          )
        )
      )
  );
$$;

revoke execute on function app.can_view_goal(uuid) from public;
grant execute on function app.can_view_goal(uuid) to authenticated, anon, service_role;


alter table public.goals enable row level security;

-- Inline rather than via can_view_goal() so goals_shared_idx stays usable on
-- list queries, matching the posts_select rationale.
create policy goals_select
  on public.goals for select
  to anon, authenticated
  using (
    profile_id = auth.uid()
    or (
      visibility <> 'private'
      and app.can_view_profile(profile_id)
      and not app.is_blocked_either_way(profile_id, auth.uid())
      and (
        visibility = 'public'
        or (visibility = 'university'  and app.share_university(profile_id, auth.uid()))
        or (visibility = 'connections' and app.are_connected(profile_id, auth.uid()))
      )
    )
  );

create policy goals_insert_own
  on public.goals for insert
  to authenticated
  with check (profile_id = auth.uid());

create policy goals_update_own
  on public.goals for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy goals_delete_own
  on public.goals for delete
  to authenticated
  using (profile_id = auth.uid());

revoke all on table public.goals from anon, authenticated;
grant select on table public.goals to anon, authenticated;
grant insert on table public.goals to authenticated;
grant update (title, description, category, status, target_value, current_value,
              unit, course_id, semester_id, project_id, visibility,
              start_date, target_date, updated_at)
  on table public.goals to authenticated;
grant delete on table public.goals to authenticated;


-- =============================================================================
-- goal_milestones
--
-- Checklist items under a goal. Their completed count is denormalised onto the
-- goal so a list of goals is one query.
-- =============================================================================

create table public.goal_milestones (
  id      uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals (id) on delete cascade,

  title text not null check (length(btrim(title)) between 1 and 200),

  is_completed boolean not null default false,
  completed_at timestamptz,

  target_date date,
  sort_order  integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index goal_milestones_goal_idx
  on public.goal_milestones (goal_id, sort_order, created_at);

create trigger goal_milestones_set_updated_at
  before update on public.goal_milestones
  for each row execute function app.set_updated_at();


create or replace function app.goal_milestones_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- completed_at follows is_completed, so the two cannot disagree.
  if new.is_completed then
    if new.completed_at is null then
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;

  return new;
end;
$$;

revoke execute on function app.goal_milestones_before_write() from public;

create trigger goal_milestones_before_write
  before insert or update on public.goal_milestones
  for each row execute function app.goal_milestones_before_write();

-- completed_at omitted for the same reason as on goals: the before-write trigger
-- derives it from is_completed at depth 1.
create trigger goal_milestones_protect_columns
  before update on public.goal_milestones
  for each row execute function app.reject_protected_column_change(
    'id', 'goal_id', 'created_at'
  );


create or replace function app.sync_goal_milestone_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_goal uuid := coalesce(new.goal_id, old.goal_id);
begin
  update public.goals g
     set milestone_count = (
           select count(*) from public.goal_milestones m where m.goal_id = v_goal
         ),
         completed_milestone_count = (
           select count(*) from public.goal_milestones m
            where m.goal_id = v_goal and m.is_completed
         )
   where g.id = v_goal;

  return null;
end;
$$;

revoke execute on function app.sync_goal_milestone_counts() from public;

create trigger goal_milestones_sync_counts
  after insert or update of is_completed or delete on public.goal_milestones
  for each row execute function app.sync_goal_milestone_counts();


alter table public.goal_milestones enable row level security;

create policy goal_milestones_select
  on public.goal_milestones for select
  to anon, authenticated
  using (app.can_view_goal(goal_id));

create policy goal_milestones_write_own
  on public.goal_milestones for all
  to authenticated
  using (exists (select 1 from public.goals g
                 where g.id = goal_milestones.goal_id and g.profile_id = auth.uid()))
  with check (exists (select 1 from public.goals g
                      where g.id = goal_milestones.goal_id and g.profile_id = auth.uid()));

revoke all on table public.goal_milestones from anon, authenticated;
grant select on table public.goal_milestones to anon, authenticated;
grant insert on table public.goal_milestones to authenticated;
grant update (title, is_completed, target_date, sort_order, updated_at)
  on table public.goal_milestones to authenticated;
grant delete on table public.goal_milestones to authenticated;


-- =============================================================================
-- study_sessions
--
-- duration_minutes is the single source of truth and ended_at is derived from
-- it. Storing both as independently writable columns invites the state where
-- they disagree, and then every report has to pick one.
--
-- ended_at would ideally be a GENERATED column, but `timestamptz + interval` is
-- STABLE rather than IMMUTABLE -- the result depends on the session TimeZone
-- once days or months are involved -- and Postgres rejects it in a generation
-- expression. So it is a plain column written by the BEFORE trigger and listed
-- as protected, which gives the same guarantee by a different route: the client
-- has no grant on it and the trigger overwrites it on every write.
-- =============================================================================

create table public.study_sessions (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  course_id uuid references public.courses (id) on delete set null,
  goal_id   uuid references public.goals   (id) on delete set null,

  started_at       timestamptz not null default now(),
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  ended_at         timestamptz not null,

  -- 1..5, self-reported. Named `focus_rating` rather than `productivity` so it
  -- is obviously an opinion about a session and not a score awarded to a person.
  focus_rating smallint check (focus_rating between 1 and 5),

  notes text check (length(notes) <= 1000),

  created_at timestamptz not null default now()
);

comment on table public.study_sessions is
  'Owner-only record of study time. Never exposed to other users: published, it
   is a presence tracker.';

create index study_sessions_profile_idx
  on public.study_sessions (profile_id, started_at desc);
create index study_sessions_course_idx
  on public.study_sessions (course_id) where course_id is not null;
create index study_sessions_goal_idx
  on public.study_sessions (goal_id) where goal_id is not null;


create or replace function app.study_sessions_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  -- Derived on every write, never accepted from the client. See the table note.
  new.ended_at := new.started_at + make_interval(mins => new.duration_minutes);

  -- now() is not immutable, so this cannot be a CHECK constraint. A small
  -- forward tolerance covers clock skew between the client and the database;
  -- beyond that, a "session" dated next year is either a bug or an attempt to
  -- game a streak.
  if new.started_at > now() + interval '1 hour' then
    raise exception 'A study session cannot start in the future'
      using errcode = '22007', hint = 'started_at_future';
  end if;

  if new.course_id is not null then
    select c.profile_id into v_owner
      from public.courses c where c.id = new.course_id;
    if v_owner is distinct from new.profile_id then
      raise exception 'That course does not belong to you'
        using errcode = '42501', hint = 'course_not_owned';
    end if;
  end if;

  if new.goal_id is not null then
    select g.profile_id into v_owner
      from public.goals g where g.id = new.goal_id;
    if v_owner is distinct from new.profile_id then
      raise exception 'That goal does not belong to you'
        using errcode = '42501', hint = 'goal_not_owned';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function app.study_sessions_before_write() from public;

create trigger study_sessions_before_write
  before insert or update on public.study_sessions
  for each row execute function app.study_sessions_before_write();

-- ended_at is deliberately NOT in this list. The before-write trigger recomputes
-- it from duration_minutes on every write, so the protected-column guard would
-- see the trigger's own change at depth 1 and reject a legitimate duration edit.
-- The absence of an UPDATE grant on the column is what keeps clients out of it.
create trigger study_sessions_protect_columns
  before update on public.study_sessions
  for each row execute function app.reject_protected_column_change(
    'id', 'profile_id', 'created_at'
  );


alter table public.study_sessions enable row level security;

create policy study_sessions_own
  on public.study_sessions for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.study_sessions from anon, authenticated;
grant select on table public.study_sessions to authenticated;
grant insert on table public.study_sessions to authenticated;
grant update (course_id, goal_id, started_at, duration_minutes, focus_rating, notes)
  on table public.study_sessions to authenticated;
grant delete on table public.study_sessions to authenticated;


-- =============================================================================
-- daily_logs
--
-- One row per day per profile — a journal, not an analytics event. Strictly
-- owner-only, including from moderators.
-- =============================================================================

create table public.daily_logs (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  log_date date not null,

  -- 1..5 scales, both self-reported.
  mood         smallint check (mood between 1 and 5),
  productivity smallint check (productivity between 1 and 5),

  hours_studied numeric(4, 1) check (hours_studied >= 0 and hours_studied <= 24),

  summary  text check (length(summary)  <= 2000),
  wins     text check (length(wins)     <= 1000),
  blockers text check (length(blockers) <= 1000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint daily_logs_one_per_day unique (profile_id, log_date)
);

comment on table public.daily_logs is
  'Private daily journal. Answered honestly this is a mental-health record; it is
   readable by the owner and by nobody else, moderators included.';

create index daily_logs_profile_idx on public.daily_logs (profile_id, log_date desc);

create trigger daily_logs_set_updated_at
  before update on public.daily_logs
  for each row execute function app.set_updated_at();


create or replace function app.daily_logs_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  -- current_date is stable, not immutable, so this is a trigger rather than a
  -- CHECK. One day of tolerance for timezones either side of the server.
  if new.log_date > current_date + 1 then
    raise exception 'A daily log cannot be dated in the future'
      using errcode = '22007', hint = 'log_date_future';
  end if;

  return new;
end;
$$;

revoke execute on function app.daily_logs_before_write() from public;

create trigger daily_logs_before_write
  before insert or update on public.daily_logs
  for each row execute function app.daily_logs_before_write();

create trigger daily_logs_protect_columns
  before update on public.daily_logs
  for each row execute function app.reject_protected_column_change(
    'id', 'profile_id', 'log_date', 'created_at'
  );


alter table public.daily_logs enable row level security;

create policy daily_logs_own
  on public.daily_logs for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.daily_logs from anon, authenticated;
grant select on table public.daily_logs to authenticated;
grant insert on table public.daily_logs to authenticated;
grant update (mood, productivity, hours_studied, summary, wins, blockers, updated_at)
  on table public.daily_logs to authenticated;
grant delete on table public.daily_logs to authenticated;


-- =============================================================================
-- current_study_streak()
--
-- Consecutive days ending today or yesterday that have a daily_logs row. A real
-- computation over real rows — there is no stored streak counter to drift, and
-- no way to set one.
--
-- Yesterday counts because today is not over. A streak that resets at midnight
-- for someone who has not opened the app yet would be a bug reported as
-- "it deleted my streak".
-- =============================================================================

create or replace function public.current_study_streak()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last   date;
  v_streak integer;
begin
  if auth.uid() is null then
    return 0;
  end if;

  select max(d.log_date) into v_last
    from public.daily_logs d
   where d.profile_id = auth.uid()
     and d.log_date <= current_date;

  if v_last is null or v_last < current_date - 1 then
    return 0;
  end if;

  -- Gap-and-island: number the days newest-first, then count the leading run
  -- whose date matches the anchor minus its position. Once a day is missing,
  -- every later row falls permanently behind that expression, so no row after
  -- the first gap can match.
  select count(*)::integer into v_streak
    from (
      select d.log_date,
             row_number() over (order by d.log_date desc) as rn
        from public.daily_logs d
       where d.profile_id = auth.uid()
         and d.log_date <= v_last
    ) numbered
   where numbered.log_date = v_last - (numbered.rn - 1)::integer;

  return coalesce(v_streak, 0);
end;
$$;

revoke execute on function public.current_study_streak() from public;
grant execute on function public.current_study_streak() to authenticated;


-- =============================================================================
-- posts.goal_id — foreign key and anchor validation
--
-- The column was declared in 0008 without a reference because goals did not
-- exist yet. Both halves of the guard matter:
--
--   * the goal must be the post author's own, otherwise anyone could publish a
--     "learning update" attached to a stranger's goal; and
--   * the post's visibility is clamped to the goal's, because the post card
--     renders the goal title. Without the clamp, marking a goal private would
--     silently leave its title on a public post.
-- =============================================================================

alter table public.posts
  add constraint posts_goal_id_fkey
  foreign key (goal_id) references public.goals (id) on delete set null;

create index posts_goal_idx on public.posts (goal_id) where goal_id is not null;


create or replace function app.posts_goal_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner      uuid;
  v_visibility text;
begin
  if new.goal_id is null then
    return new;
  end if;

  select g.profile_id, g.visibility
    into v_owner, v_visibility
    from public.goals g where g.id = new.goal_id;

  if not app.is_privileged_role()
     and (tg_op = 'INSERT' or new.goal_id is distinct from old.goal_id)
     and v_owner is distinct from new.author_id
  then
    raise exception 'That goal does not belong to you'
      using errcode = '42501', hint = 'goal_not_owned';
  end if;

  -- Applied on every write, not only when goal_id changes: the goal's own
  -- visibility may have been lowered since the post was created.
  new.visibility := app.clamp_visibility(new.visibility, coalesce(v_visibility, 'private'));

  return new;
end;
$$;

revoke execute on function app.posts_goal_anchor() from public;

-- Fires after posts_before_write (b < g in trigger name order), so author_id has
-- already been forced to auth.uid() and the author-visibility clamp applied.
create trigger posts_goal_anchor
  before insert or update on public.posts
  for each row execute function app.posts_goal_anchor();
