-- =============================================================================
-- 0012  Achievements
-- =============================================================================
-- WHAT AN ACHIEVEMENT IS HERE, AND WHAT IT IS NOT
-- -----------------------------------------------
-- Every row in profile_achievements is a record of something the database
-- counted: posts published, projects owned, connections accepted, consecutive
-- days logged. It is a receipt for platform activity.
--
-- It is NOT a claim about ability. "Published 50 posts" is a fact; "good
-- writer" is not, and nothing in this file may be worded as the second thing.
-- The same rule that governs profile_skills.level governs this table: the
-- platform cannot verify skill and does not pretend to (spec §33, §60).
--
-- WHY CLIENTS CANNOT INSERT
-- -------------------------
-- `authenticated` has no INSERT, UPDATE-of-key, or DELETE privilege on
-- profile_achievements. Awards happen in exactly one place --
-- app.award_achievement(), called from triggers on the tables that hold the
-- underlying counts. If a client could insert, the badge would mean "this user
-- sent a POST request", which is worth less than showing nothing at all.
--
-- Every threshold below is checked against a column some other trigger already
-- maintains (profiles.post_count, profiles.connection_count, and so on), so
-- there is no second, independently-drifting count to keep in step.
--
-- IDEMPOTENCE
-- -----------
-- award_achievement is `on conflict do nothing`. The evaluation triggers fire on
-- every counter change, so most calls are no-ops; that is deliberate, because
-- the alternative is remembering which thresholds have been crossed, which is
-- the same state twice.
-- =============================================================================


-- =============================================================================
-- achievement_definitions
--
-- Reference data, seeded by this migration. Every definition names the fact it
-- is derived from in `criteria`, and that text is what the UI must show -- a
-- badge whose meaning the user cannot look up is decoration.
-- =============================================================================

create table public.achievement_definitions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,48}$'),

  name        text not null check (length(btrim(name)) between 1 and 60),
  description text not null check (length(btrim(description)) between 1 and 240),

  -- Plain-language statement of exactly what was counted. Shown to the user.
  criteria text not null check (length(btrim(criteria)) between 1 and 240),

  category text not null
           check (category in ('participation', 'building', 'community',
                               'learning', 'consistency')),

  -- Presentational tiers only. They order badges on a profile; they do not
  -- imply that a gold badge holder is better at anything than a bronze one.
  tier text not null default 'bronze'
       check (tier in ('bronze', 'silver', 'gold')),

  icon text not null check (length(btrim(icon)) between 1 and 40),

  sort_order integer not null default 0,
  is_active  boolean not null default true,

  created_at timestamptz not null default now()
);

comment on table public.achievement_definitions is
  'Catalogue of awardable achievements. Each one describes a counted platform
   event, never an assessment of ability.';
comment on column public.achievement_definitions.tier is
  'Presentational ordering only. Carries no claim about the holder.';

create index achievement_definitions_active_idx
  on public.achievement_definitions (category, sort_order)
  where is_active;


-- The catalogue is seeded here, before RLS is enabled on the table. A table
-- owner bypasses RLS anyway, so the order is not strictly required -- but it
-- means the seed does not depend on who runs the migration.
insert into public.achievement_definitions
  (key, name, description, criteria, category, tier, icon, sort_order) values

  -- participation -------------------------------------------------------------
  ('first_post', 'First Post',
   'You posted something to the network.',
   'Published 1 post.',
   'participation', 'bronze', 'pencil', 10),
  ('posts_10', 'Regular Contributor',
   'Ten posts published.',
   'Published 10 posts.',
   'participation', 'bronze', 'pencil', 11),
  ('posts_50', 'Prolific Contributor',
   'Fifty posts published.',
   'Published 50 posts.',
   'participation', 'silver', 'pencil', 12),
  ('profile_complete', 'Profile Complete',
   'Your profile has a photo, a headline, a bio and a university.',
   'Filled in avatar, headline, bio and university, and finished onboarding.',
   'participation', 'bronze', 'badge-check', 13),

  -- building ------------------------------------------------------------------
  ('first_project', 'Project Started',
   'You created your first project.',
   'Owner of 1 project.',
   'building', 'bronze', 'hammer', 20),
  ('projects_5', 'Serial Builder',
   'Five projects created.',
   'Owner of 5 projects.',
   'building', 'silver', 'hammer', 21),
  ('first_idea', 'Idea Shared',
   'You put an idea on the board.',
   'Posted 1 idea.',
   'building', 'bronze', 'lightbulb', 22),
  ('idea_converted', 'Idea to Project',
   'One of your ideas became a real project.',
   'Converted 1 idea into a project.',
   'building', 'silver', 'rocket', 23),
  ('team_member', 'Team Player',
   'You joined a project someone else started.',
   'Member of 1 project you do not own.',
   'building', 'bronze', 'users', 24),

  -- community -----------------------------------------------------------------
  ('first_connection', 'First Connection',
   'You and another student connected.',
   'Accepted 1 connection.',
   'community', 'bronze', 'link', 30),
  ('connections_25', 'Well Connected',
   'Twenty-five accepted connections.',
   'Accepted 25 connections.',
   'community', 'silver', 'link', 31),
  ('endorsed_5', 'Endorsed',
   'Five endorsements on one of your skills.',
   'Received 5 endorsements on a single skill. Endorsements are peer opinions, '
   || 'not verification.',
   'community', 'silver', 'thumbs-up', 32),

  -- learning ------------------------------------------------------------------
  ('first_goal', 'Goal Set',
   'You set your first learning goal.',
   'Created 1 goal.',
   'learning', 'bronze', 'target', 40),
  ('goal_completed', 'Goal Reached',
   'You marked a goal complete.',
   'Marked 1 self-reported goal as completed.',
   'learning', 'bronze', 'flag', 41),
  ('goals_completed_10', 'Ten Goals Down',
   'Ten goals marked complete.',
   'Marked 10 self-reported goals as completed.',
   'learning', 'gold', 'flag', 42),

  -- consistency ---------------------------------------------------------------
  ('streak_7', 'Seven Day Streak',
   'You logged your studying seven days in a row.',
   'Daily log on 7 consecutive days.',
   'consistency', 'bronze', 'calendar-check', 50),
  ('streak_30', 'Thirty Day Streak',
   'You logged your studying thirty days in a row.',
   'Daily log on 30 consecutive days.',
   'consistency', 'gold', 'calendar-check', 51);


alter table public.achievement_definitions enable row level security;

-- The catalogue is public: a visitor looking at a badge on a public profile needs
-- to be able to read what it means. A badge whose criteria the reader cannot
-- check is exactly the kind of unearned credential this file exists to avoid.
create policy achievement_definitions_select
  on public.achievement_definitions for select
  to anon, authenticated
  using (true);

create policy achievement_definitions_write_admin
  on public.achievement_definitions for all
  to authenticated
  using (app.is_admin()) with check (app.is_admin());

revoke all on table public.achievement_definitions from anon, authenticated;
grant select on table public.achievement_definitions to anon, authenticated;
grant insert, update, delete on table public.achievement_definitions to authenticated;


-- =============================================================================
-- profile_achievements
-- =============================================================================

create table public.profile_achievements (
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  achievement_key text not null
                  references public.achievement_definitions (key) on delete cascade,

  awarded_at timestamptz not null default now(),

  -- The value of the underlying counter at the moment the award fired, so a
  -- badge can read "reached at 62 posts" instead of implying the user has
  -- exactly the threshold. Never revised afterwards -- it records the crossing,
  -- not the current total, which the profile already holds.
  awarded_value integer,

  -- The holder chooses which badges appear on their profile header.
  is_pinned boolean not null default false,

  primary key (profile_id, achievement_key)
);

comment on table public.profile_achievements is
  'Awarded only by app.award_achievement(), called from triggers on the tables
   holding the underlying counts. No client INSERT/DELETE grant exists.';

create index profile_achievements_profile_idx
  on public.profile_achievements (profile_id, awarded_at desc);
create index profile_achievements_pinned_idx
  on public.profile_achievements (profile_id) where is_pinned;


-- -----------------------------------------------------------------------------
-- app.award_achievement(profile, key, value)
--
-- The only way a row enters profile_achievements. Idempotent, and silent when
-- the key is unknown or inactive: an evaluation trigger must not be able to
-- abort someone's post because a definition was renamed.
-- -----------------------------------------------------------------------------
create or replace function app.award_achievement(
  v_profile uuid,
  v_key text,
  v_value integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean := false;
begin
  if v_profile is null or v_key is null then
    return false;
  end if;

  if not exists (
    select 1 from public.achievement_definitions d
     where d.key = v_key and d.is_active
  ) then
    return false;
  end if;

  insert into public.profile_achievements (profile_id, achievement_key, awarded_value)
  values (v_profile, v_key, v_value)
  on conflict (profile_id, achievement_key) do nothing;

  v_inserted := found;
  return v_inserted;
end;
$$;

revoke execute on function app.award_achievement(uuid, text, integer) from public;
-- Not granted to any client role. Callable only from trigger bodies, where
-- Postgres does not check EXECUTE privilege.


-- -----------------------------------------------------------------------------
-- Evaluation: profile counters
--
-- One trigger for every threshold that reads a profiles column. Fires AFTER
-- UPDATE OF the specific counters, so an ordinary profile edit does no work.
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_profile_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.post_count >= 1  then perform app.award_achievement(new.id, 'first_post', new.post_count); end if;
  if new.post_count >= 10 then perform app.award_achievement(new.id, 'posts_10',   new.post_count); end if;
  if new.post_count >= 50 then perform app.award_achievement(new.id, 'posts_50',   new.post_count); end if;

  if new.project_count >= 1 then perform app.award_achievement(new.id, 'first_project', new.project_count); end if;
  if new.project_count >= 5 then perform app.award_achievement(new.id, 'projects_5',    new.project_count); end if;

  if new.connection_count >= 1  then perform app.award_achievement(new.id, 'first_connection', new.connection_count); end if;
  if new.connection_count >= 25 then perform app.award_achievement(new.id, 'connections_25',   new.connection_count); end if;

  -- "Complete" is defined by the fields the profile page actually renders, not
  -- by a percentage invented for a progress bar.
  if new.onboarding_completed
     and new.avatar_url    is not null
     and new.headline      is not null and length(btrim(new.headline)) > 0
     and new.bio           is not null and length(btrim(new.bio))      > 0
     and new.university_id is not null
  then
    perform app.award_achievement(new.id, 'profile_complete', null);
  end if;

  return null;
end;
$$;

revoke execute on function app.evaluate_profile_achievements() from public;

create trigger profiles_evaluate_achievements
  after update of post_count, project_count, connection_count,
                  onboarding_completed, avatar_url, headline, bio, university_id
  on public.profiles
  for each row execute function app.evaluate_profile_achievements();


-- -----------------------------------------------------------------------------
-- Evaluation: ideas
--
-- ideas has no denormalised count on profiles, so the trigger counts. The table
-- is small per author and the index on (author_id, created_at) covers it.
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_idea_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if tg_op = 'INSERT' then
    select count(*) into v_count
      from public.ideas i where i.author_id = new.author_id;

    if v_count >= 1 then
      perform app.award_achievement(new.author_id, 'first_idea', v_count);
    end if;
  end if;

  if new.converted_project_id is not null
     and (tg_op = 'INSERT' or old.converted_project_id is null)
  then
    perform app.award_achievement(new.author_id, 'idea_converted', null);
  end if;

  return null;
end;
$$;

revoke execute on function app.evaluate_idea_achievements() from public;

create trigger ideas_evaluate_achievements
  after insert or update of converted_project_id on public.ideas
  for each row execute function app.evaluate_idea_achievements();


-- -----------------------------------------------------------------------------
-- Evaluation: joining someone else's project
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_membership_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Owning a project is 'first_project'; this badge is specifically about
  -- joining something you did not start.
  if new.role <> 'owner' then
    perform app.award_achievement(new.profile_id, 'team_member', null);
  end if;

  return null;
end;
$$;

revoke execute on function app.evaluate_membership_achievements() from public;

create trigger project_members_evaluate_achievements
  after insert on public.project_members
  for each row execute function app.evaluate_membership_achievements();


-- -----------------------------------------------------------------------------
-- Evaluation: endorsements
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_endorsement_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.endorsement_count >= 5 then
    perform app.award_achievement(new.profile_id, 'endorsed_5', new.endorsement_count);
  end if;
  return null;
end;
$$;

revoke execute on function app.evaluate_endorsement_achievements() from public;

create trigger profile_skills_evaluate_achievements
  after update of endorsement_count on public.profile_skills
  for each row execute function app.evaluate_endorsement_achievements();


-- -----------------------------------------------------------------------------
-- Evaluation: goals
--
-- 'goal_completed' is awarded for a self-reported completion, and the criteria
-- text says so. Awarding it does not make the completion verified.
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_goal_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total     integer;
  v_completed integer;
begin
  if tg_op = 'INSERT' then
    select count(*) into v_total
      from public.goals g where g.profile_id = new.profile_id;
    if v_total >= 1 then
      perform app.award_achievement(new.profile_id, 'first_goal', v_total);
    end if;
  end if;

  if new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed')
  then
    select count(*) into v_completed
      from public.goals g
     where g.profile_id = new.profile_id and g.status = 'completed';

    perform app.award_achievement(new.profile_id, 'goal_completed', v_completed);

    if v_completed >= 10 then
      perform app.award_achievement(new.profile_id, 'goals_completed_10', v_completed);
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function app.evaluate_goal_achievements() from public;

create trigger goals_evaluate_achievements
  after insert or update of status on public.goals
  for each row execute function app.evaluate_goal_achievements();


-- -----------------------------------------------------------------------------
-- Evaluation: study streaks
--
-- Recomputed from daily_logs rather than read from a stored counter, so there is
-- no streak number that can drift from the days actually logged. The gap-and-
-- island query is the same one public.current_study_streak() uses; it is
-- repeated here rather than called because that function is scoped to
-- auth.uid(), and a trigger must evaluate the row's owner instead.
-- -----------------------------------------------------------------------------
create or replace function app.evaluate_streak_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_streak integer;
begin
  select count(*) into v_streak
    from (
      select d.log_date,
             row_number() over (order by d.log_date desc) as rn
        from public.daily_logs d
       where d.profile_id = new.profile_id
         and d.log_date <= new.log_date
    ) numbered
   where numbered.log_date = new.log_date - (numbered.rn - 1)::integer;

  if v_streak >= 7  then perform app.award_achievement(new.profile_id, 'streak_7',  v_streak); end if;
  if v_streak >= 30 then perform app.award_achievement(new.profile_id, 'streak_30', v_streak); end if;

  return null;
end;
$$;

revoke execute on function app.evaluate_streak_achievements() from public;

create trigger daily_logs_evaluate_achievements
  after insert on public.daily_logs
  for each row execute function app.evaluate_streak_achievements();


-- =============================================================================
-- profile_achievements policies
--
-- Readable wherever the profile is readable, so a badge on a public profile
-- works for a visitor. The only client-writable column is is_pinned.
-- =============================================================================

alter table public.profile_achievements enable row level security;

create policy profile_achievements_select
  on public.profile_achievements for select
  to anon, authenticated
  using (profile_id = auth.uid() or app.can_view_profile(profile_id));

create policy profile_achievements_pin_own
  on public.profile_achievements for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.profile_achievements from anon, authenticated;
grant select on table public.profile_achievements to anon, authenticated;
-- No INSERT and no DELETE, for any client role. An achievement that a client
-- could create or erase is not a record of anything.
grant update (is_pinned) on table public.profile_achievements to authenticated;

create trigger profile_achievements_protect_columns
  before update on public.profile_achievements
  for each row execute function app.reject_protected_column_change(
    'profile_id', 'achievement_key', 'awarded_at', 'awarded_value'
  );


-- =============================================================================
-- posts.achievement_key — foreign key and anchor validation
--
-- 0008 declared the column as bare text. The FK and the ownership check land
-- here, for the same reason as posts.goal_id: without them anyone could publish
-- an 'achievement' post naming a badge they do not hold, which is precisely the
-- fake-credential problem the award triggers exist to avoid.
-- =============================================================================

alter table public.posts
  add constraint posts_achievement_key_fkey
  foreign key (achievement_key)
  references public.achievement_definitions (key) on delete set null;

create index posts_achievement_idx on public.posts (achievement_key)
  where achievement_key is not null;


create or replace function app.posts_achievement_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.achievement_key is null then
    return new;
  end if;

  if not app.is_privileged_role()
     and (tg_op = 'INSERT' or new.achievement_key is distinct from old.achievement_key)
     and not exists (
       select 1 from public.profile_achievements pa
        where pa.profile_id = new.author_id
          and pa.achievement_key = new.achievement_key
     )
  then
    raise exception 'You have not been awarded that achievement'
      using errcode = '42501', hint = 'achievement_not_held';
  end if;

  return new;
end;
$$;

revoke execute on function app.posts_achievement_anchor() from public;

-- Row-level triggers of the same type fire in trigger-NAME order, and this one
-- must run after posts_before_write has forced author_id -- otherwise the
-- ownership check below reads whatever author_id the client sent. 'c' > 'b', so
-- the name does the ordering.
create trigger posts_check_achievement
  before insert or update on public.posts
  for each row execute function app.posts_achievement_anchor();
