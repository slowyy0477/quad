-- =============================================================================
-- 0014_notifications.sql
--
-- Notifications: what happened, to whom, and who caused it.
--
-- WHY NO CLIENT CAN WRITE ONE
--
-- A notification is a claim that something happened. If a client could insert
-- one, the claim would only mean "somebody sent a POST request", and the entire
-- surface would become a channel for impersonation: anyone could make a
-- notification appear that reads "Ana endorsed you" or "your post was removed".
-- So `notifications` has no INSERT grant and no INSERT policy for any client
-- role, and every row originates from a trigger on the table where the real
-- event was recorded. `app.create_notification()` is the only writer, and it is
-- granted to no client role either.
--
-- A user may mark their own notifications read and may delete them. That is
-- different in kind: a notification is a delivery mechanism, not a record
-- anyone else relies on, and dismissing your own copy destroys no evidence.
-- The moderation record itself lives elsewhere (0015) and is append-only.
--
-- WHY THE TYPE LIST IS A TABLE AND NOT A CHECK CONSTRAINT
--
-- Each type needs a category (which preference switch governs it) and a
-- resurface rule (whether a second occurrence should bring an already-read
-- notification back). Holding those in a CHECK constraint plus a CASE
-- expression means two lists that can silently disagree. A row in
-- `notification_types` cannot have a type without a category, because the
-- category column is NOT NULL in the same row.
--
-- DEDUPLICATION
--
-- `notifications_dedupe` is a UNIQUE ... NULLS NOT DISTINCT constraint over the
-- recipient, the type, the actor and every entity column. Postgres therefore
-- decides whether two occurrences are "the same notification"; no application
-- code races to find out. Liking a post, unliking it and liking it again
-- produces one notification, and two different people liking the same post
-- produce two, because the actor participates in the key.
--
-- NULLS NOT DISTINCT is the point: without it, every notification with a null
-- entity column would be considered unique and the constraint would never fire.
--
-- WHAT IS NOT HERE
--
--   Mentions.  There is no @-mention parsing anywhere in the schema yet, so
--              there is no `mention` type. A type nothing can emit is a
--              promise the product has not kept.
--   Email.     `notification_preferences` has one channel column, in_app_
--              enabled, because in-app is the only channel that exists. An
--              email toggle that sends no email is a decorative control.
--   Digests.   Nothing batches notifications into a summary yet.
--
-- SCHEDULED REMINDERS
--
-- `public.dispatch_due_reminders()` really does create event reminders and
-- opportunity-deadline notifications, but nothing calls it on a schedule from
-- inside the database. It needs a pg_cron job, documented in DEPLOYMENT.md.
-- Until that job exists, reminders do not fire, and no UI may claim they do.
-- =============================================================================


-- =============================================================================
-- notification_categories
--
-- The unit a user's preferences operate on. Grouping by category rather than by
-- type is deliberate: twenty-seven individual switches is a settings page
-- nobody reads, and a user who wants "no more likes" does not want to reason
-- about post_like versus comment_like.
--
-- The label and description live here rather than in TypeScript so the settings
-- page renders one row per category that actually exists. A hard-coded list in
-- the client would drift the first time a category is added.
-- =============================================================================
create table public.notification_categories (
  category text primary key check (category ~ '^[a-z][a-z_]{2,32}$'),

  label       text not null check (length(btrim(label)) between 1 and 60),
  description text not null check (length(btrim(description)) between 1 and 240),

  -- false means the user cannot switch this off. Reserved for notifications the
  -- platform owes them regardless of preference: being told your own content
  -- was hidden is not marketing.
  is_suppressible boolean not null default true,

  sort_order integer not null default 100
);

comment on table public.notification_categories is
  'Preference groups for notifications. Seeded by migration; not client-writable.';

insert into public.notification_categories
  (category, label, description, is_suppressible, sort_order)
values
  ('social', 'Follows and connections',
   'When someone follows you, sends you a connection request, or accepts one.',
   true, 10),
  ('engagement', 'Reactions and replies',
   'When someone likes or comments on your posts, endorses a skill, or responds to an idea.',
   true, 20),
  ('projects', 'Projects and applications',
   'When someone applies to a project you manage, responds to an invite, or joins your team.',
   true, 30),
  ('messages', 'Direct messages',
   'When you receive a message in a conversation you have not muted.',
   true, 40),
  ('learning', 'Learning and achievements',
   'When you are awarded an achievement for activity the platform counted.',
   true, 50),
  ('events', 'Events and deadlines',
   'When an event you are attending changes, and reminders for events and application deadlines.',
   true, 60),
  ('moderation', 'Moderation decisions',
   'When your content is hidden or removed. These cannot be switched off.',
   false, 70);

alter table public.notification_categories enable row level security;

create policy notification_categories_select
  on public.notification_categories for select
  to anon, authenticated
  using (true);

create policy notification_categories_write_admin
  on public.notification_categories for all
  to authenticated
  using (app.is_admin())
  with check (app.is_admin());

revoke all on table public.notification_categories from anon, authenticated;
grant select on table public.notification_categories to anon, authenticated;


-- =============================================================================
-- notification_types
--
-- One row per thing the database can tell a user about. `category` decides
-- which preference governs it; `resurfaces` decides what a repeat occurrence
-- does to an already-read notification.
-- =============================================================================
create table public.notification_types (
  type text primary key check (type ~ '^[a-z][a-z0-9_]{2,48}$'),

  category text not null
    references public.notification_categories (category) on delete restrict,

  -- true: a later occurrence updates the existing row, clears its read flag and
  --       moves it back to the top of the list. Correct for a stream of events
  --       that collapse into one line ("new messages in this conversation").
  -- false: the first occurrence is the only one. Correct for a discrete event,
  --       and the anti-spam default -- a request that is withdrawn and re-sent
  --       must not be able to ring the same bell twice.
  resurfaces boolean not null default false,

  sort_order integer not null default 100
);

comment on table public.notification_types is
  'Catalogue of notification types. A type absent from here cannot be created: '
  'notifications.type is a foreign key to it.';

insert into public.notification_types (type, category, resurfaces, sort_order)
values
  -- social
  ('follow',                        'social',     false, 10),
  ('connection_request',            'social',     false, 20),
  ('connection_accepted',           'social',     false, 30),

  -- engagement
  ('post_like',                     'engagement', false, 10),
  ('post_comment',                  'engagement', false, 20),
  ('comment_reply',                 'engagement', false, 30),
  ('comment_like',                  'engagement', false, 40),
  ('project_star',                  'engagement', false, 50),
  ('idea_vote',                     'engagement', false, 60),
  ('idea_interest',                 'engagement', false, 70),
  ('idea_comment',                  'engagement', false, 80),
  ('skill_endorsement',             'engagement', false, 90),

  -- projects
  ('project_application',           'projects',   false, 10),
  ('project_application_accepted',  'projects',   false, 20),
  ('project_application_rejected',  'projects',   false, 30),
  ('project_invite',                'projects',   false, 40),
  ('project_invite_accepted',       'projects',   false, 50),
  ('project_invite_declined',       'projects',   false, 60),
  ('project_member_joined',         'projects',   false, 70),
  ('project_ownership_received',    'projects',   false, 80),

  -- messages
  ('message',                       'messages',   true,  10),

  -- learning
  ('achievement_awarded',           'learning',   false, 10),

  -- events
  ('event_cancelled',               'events',     false, 10),
  ('event_rescheduled',             'events',     true,  20),
  ('event_reminder',                'events',     false, 30),
  ('opportunity_deadline',          'events',     false, 40),

  -- moderation
  ('content_hidden',                'moderation', false, 10),
  ('content_removed',               'moderation', false, 20);

alter table public.notification_types enable row level security;

create policy notification_types_select
  on public.notification_types for select
  to anon, authenticated
  using (true);

create policy notification_types_write_admin
  on public.notification_types for all
  to authenticated
  using (app.is_admin())
  with check (app.is_admin());

revoke all on table public.notification_types from anon, authenticated;
grant select on table public.notification_types to anon, authenticated;


-- =============================================================================
-- notification_preferences
--
-- Row-per-(profile, category), and a MISSING ROW MEANS ENABLED. That choice
-- removes a whole class of bug: there is no backfill to run when a category is
-- added, no trigger that must remember to create seven rows for every new
-- profile, and no window during signup where a user has no preferences and the
-- reader has to guess.
-- =============================================================================
create table public.notification_preferences (
  profile_id uuid not null references public.profiles (id) on delete cascade,

  category text not null
    references public.notification_categories (category) on delete cascade,

  -- The only channel that exists. An email column arrives with the email
  -- module, not before it.
  in_app_enabled boolean not null default true,

  updated_at timestamptz not null default now(),

  primary key (profile_id, category)
);

comment on table public.notification_preferences is
  'Per-user notification switches. A missing row means enabled.';

-- A stored `false` for a non-suppressible category would be an inert setting:
-- the notification would arrive anyway and the settings page would be lying.
-- Refuse it at the source instead.
create or replace function app.notification_preferences_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suppressible boolean;
begin
  if not app.is_privileged_role() then
    new.profile_id := auth.uid();
  end if;

  select c.is_suppressible into v_suppressible
    from public.notification_categories c
   where c.category = new.category;

  if v_suppressible is null then
    raise exception 'Unknown notification category'
      using errcode = '23503', hint = 'unknown_notification_category';
  end if;

  if not v_suppressible and not new.in_app_enabled then
    raise exception 'That notification category cannot be switched off'
      using errcode = '23514', hint = 'category_not_suppressible';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function app.notification_preferences_before_write() from public;

create trigger notification_preferences_before_write
  before insert or update on public.notification_preferences
  for each row execute function app.notification_preferences_before_write();

alter table public.notification_preferences enable row level security;

create policy notification_preferences_own
  on public.notification_preferences for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

revoke all on table public.notification_preferences from anon, authenticated;
grant select, insert, delete on table public.notification_preferences to authenticated;
grant update (in_app_enabled) on table public.notification_preferences to authenticated;


-- =============================================================================
-- notifications
--
-- WHY THE ENTITY REFERENCES ARE TYPED COLUMNS
--
-- A polymorphic (entity_type, entity_id) pair is shorter to write and cannot be
-- given a foreign key. Without one, hard-deleting a post leaves a notification
-- pointing at nothing, and the user gets a row that renders as a dead link with
-- no way for the database to know it is dead. Typed columns with ON DELETE
-- CASCADE make the cleanup the database's problem, which is where it belongs.
--
-- Two of them are populated together on purpose: a comment notification carries
-- both comment_id and post_id, so the link can open the post and scroll to the
-- comment without a second query.
--
-- Soft deletion is a different matter. A soft-deleted post still exists, so its
-- notification survives; the read path must filter on the post's visibility,
-- exactly as every other read path does.
-- =============================================================================
create table public.notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_id uuid not null references public.profiles (id) on delete cascade,

  type text not null
    references public.notification_types (type) on delete restrict,

  -- Null for notifications with no human cause: an awarded achievement, a
  -- deadline reminder, a moderation decision. Moderation notifications
  -- deliberately do not name the moderator.
  actor_id uuid references public.profiles (id) on delete cascade,

  post_id         uuid references public.posts (id)          on delete cascade,
  comment_id      uuid references public.comments (id)       on delete cascade,
  project_id      uuid references public.projects (id)       on delete cascade,
  idea_id         uuid references public.ideas (id)          on delete cascade,
  event_id        uuid references public.events (id)         on delete cascade,
  opportunity_id  uuid references public.opportunities (id)  on delete cascade,
  conversation_id uuid references public.conversations (id)  on delete cascade,
  skill_id        uuid references public.skills (id)         on delete cascade,
  achievement_key text references public.achievement_definitions (key)
                                                             on delete cascade,

  -- Free text, used only where the notification cannot be rendered from its
  -- type and entities alone -- currently a moderation note. Everything else is
  -- composed in the client from the type and the joined rows, so a rename or a
  -- translation does not have to rewrite history.
  body text check (length(body) <= 500),

  is_read boolean not null default false,
  read_at timestamptz,

  -- For a resurfacing type this is the most recent occurrence, not the first.
  -- The notification list and its keyset cursor both sort by it.
  created_at timestamptz not null default now(),

  constraint notifications_read_coherent
    check ((read_at is not null) = is_read),

  -- Nobody is notified about their own action. Enforced here as well as in
  -- app.create_notification() because a trigger added later might forget.
  constraint notifications_not_self
    check (actor_id is null or actor_id <> recipient_id),

  constraint notifications_dedupe unique nulls not distinct (
    recipient_id, type, actor_id,
    post_id, comment_id, project_id, idea_id, event_id, opportunity_id,
    conversation_id, skill_id, achievement_key
  )
);

comment on table public.notifications is
  'One row per thing a user is told about. Written only by triggers, through '
  'app.create_notification(). No client role has INSERT.';

-- The list query: one user's notifications, newest first, keyset-paginated.
create index notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc, id desc);

-- The badge count. Partial, so it stays small however long the history grows.
create index notifications_unread_idx
  on public.notifications (recipient_id)
  where not is_read;

-- Used when a block is created and the blocked party's notifications are
-- withdrawn from the blocker's list.
create index notifications_actor_idx
  on public.notifications (actor_id)
  where actor_id is not null;

-- read_at is derived from is_read, not supplied. It is not in the UPDATE grant,
-- so a client cannot set it directly, and it is not re-stamped when a row that
-- is already read is written again.
create or replace function app.notifications_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_read then
    if tg_op = 'INSERT' or not old.is_read then
      new.read_at := now();
    end if;
  else
    new.read_at := null;
  end if;

  return new;
end;
$$;

revoke execute on function app.notifications_before_write() from public;

create trigger notifications_before_write
  before insert or update on public.notifications
  for each row execute function app.notifications_before_write();

alter table public.notifications enable row level security;

create policy notifications_select
  on public.notifications for select
  to authenticated
  using (recipient_id = auth.uid());

create policy notifications_update_own
  on public.notifications for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create policy notifications_delete_own
  on public.notifications for delete
  to authenticated
  using (recipient_id = auth.uid());

-- There is no insert policy, for any role. Deliberate: see the file header.
revoke all on table public.notifications from anon, authenticated;
grant select, delete on table public.notifications to authenticated;
-- is_read is the only writable column. Everything else -- who the notification
-- is for, what it says, what it points at -- is fixed at creation. The absence
-- of the grant is the defence; there is no protect-columns trigger because
-- there is nothing left for one to protect.
grant update (is_read) on table public.notifications to authenticated;


-- =============================================================================
-- app.notification_allowed
--
-- A missing preference row means enabled, and a non-suppressible category is
-- always enabled. Both fall out of NOT EXISTS rather than needing a default to
-- be spelled out twice.
-- =============================================================================
create or replace function app.notification_allowed(v_profile uuid, v_category text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.notification_categories c
      join public.notification_preferences p
        on p.category = c.category
       and p.profile_id = v_profile
     where c.category = v_category
       and c.is_suppressible
       and not p.in_app_enabled
  );
$$;

revoke execute on function app.notification_allowed(uuid, text) from public;


-- =============================================================================
-- app.create_notification
--
-- The single writer. Every rule that decides whether a notification exists at
-- all lives here, so there is one place to read and one place to test:
--
--   1. no recipient, no notification;
--   2. nobody is told about their own action;
--   3. an unknown type is a bug in a trigger and raises, because silently
--      dropping it would make the missing notification someone's afternoon;
--   4. a block in either direction suppresses it;
--   5. a deleted profile is not notified;
--   6. the recipient's preference for the category is honoured, unless the
--      category is not suppressible;
--   7. a duplicate collapses -- into nothing, or into a resurfaced row.
--
-- Returns true when a row was written or resurfaced. Callers ignore the result;
-- it exists so tests can assert on the decision rather than inferring it.
-- =============================================================================
create or replace function app.create_notification(
  v_recipient     uuid,
  v_type          text,
  v_actor         uuid default null,
  v_post          uuid default null,
  v_comment       uuid default null,
  v_project       uuid default null,
  v_idea          uuid default null,
  v_event         uuid default null,
  v_opportunity   uuid default null,
  v_conversation  uuid default null,
  v_skill         uuid default null,
  v_achievement   text default null,
  v_body          text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category   text;
  v_resurfaces boolean;
  v_written    boolean := false;
begin
  if v_recipient is null or v_type is null then
    return false;
  end if;

  if v_actor is not null and v_actor = v_recipient then
    return false;
  end if;

  select t.category, t.resurfaces
    into v_category, v_resurfaces
    from public.notification_types t
   where t.type = v_type;

  if v_category is null then
    raise exception 'Unknown notification type: %', v_type
      using errcode = '22023', hint = 'unknown_notification_type';
  end if;

  if app.is_blocked_either_way(v_recipient, v_actor) then
    return false;
  end if;

  if not exists (
    select 1 from public.profiles p
     where p.id = v_recipient and p.deleted_at is null
  ) then
    return false;
  end if;

  if not app.notification_allowed(v_recipient, v_category) then
    return false;
  end if;

  if v_resurfaces then
    insert into public.notifications (
      recipient_id, type, actor_id,
      post_id, comment_id, project_id, idea_id, event_id, opportunity_id,
      conversation_id, skill_id, achievement_key, body
    )
    values (
      v_recipient, v_type, v_actor,
      v_post, v_comment, v_project, v_idea, v_event, v_opportunity,
      v_conversation, v_skill, v_achievement, v_body
    )
    on conflict on constraint notifications_dedupe do update
       set created_at = now(),
           is_read    = false,
           body       = excluded.body;

    v_written := true;
  else
    insert into public.notifications (
      recipient_id, type, actor_id,
      post_id, comment_id, project_id, idea_id, event_id, opportunity_id,
      conversation_id, skill_id, achievement_key, body
    )
    values (
      v_recipient, v_type, v_actor,
      v_post, v_comment, v_project, v_idea, v_event, v_opportunity,
      v_conversation, v_skill, v_achievement, v_body
    )
    on conflict on constraint notifications_dedupe do nothing;

    v_written := found;
  end if;

  return v_written;
end;
$$;

-- Granted to no client role. A notification a client could ask for is not a
-- notification, it is a broadcast primitive.
revoke execute on function app.create_notification(
  uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text
) from public;


-- =============================================================================
-- public.unread_notification_count
--
-- Counted, not stored. A denormalised unread counter would be a second number
-- maintained by a second trigger, and the two would eventually disagree with
-- the rows themselves. The partial index makes the count cheap, and the
-- function takes no argument so it cannot be pointed at anyone else.
-- =============================================================================
create or replace function public.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.notifications n
   where n.recipient_id = auth.uid()
     and not n.is_read;
$$;

-- `from public` alone is not enough for a function in the public schema.
-- Supabase's default privileges grant EXECUTE on new functions *directly* to
-- anon, authenticated and service_role, and revoking the implicit PUBLIC grant
-- leaves those three untouched. Every restricted function therefore has to name
-- the roles. See 0015_function_grants.sql, which closes the same hole in the
-- functions written before this was understood.
revoke execute on function public.unread_notification_count() from public, anon;
grant execute on function public.unread_notification_count() to authenticated;


-- =============================================================================
-- Fan-out: social graph
-- =============================================================================
create or replace function app.notify_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.create_notification(new.following_id, 'follow', new.follower_id);
  return null;
end;
$$;

revoke execute on function app.notify_follow() from public;

create trigger follows_notify
  after insert on public.follows
  for each row execute function app.notify_follow();


-- A request notifies the addressee; an acceptance notifies the requester, since
-- the addressee is the one who accepted and already knows.
create or replace function app.notify_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform app.create_notification(
        new.addressee_id, 'connection_request', new.requester_id
      );
    end if;
  elsif new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform app.create_notification(
      new.requester_id, 'connection_accepted', new.addressee_id
    );
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_connection() from public;

create trigger connections_notify
  after insert or update of status on public.connections
  for each row execute function app.notify_connection();


-- =============================================================================
-- Fan-out: posts and comments
--
-- A top-level comment notifies the post's author. A reply notifies the author
-- of the comment it replies to, and nobody else. The alternative -- notifying
-- the post author about every reply in every thread as well -- turns one busy
-- post into a stream, and the author sees the whole thread the moment they open
-- their own post anyway.
-- =============================================================================
create or replace function app.notify_post_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select p.author_id into v_author
    from public.posts p where p.id = new.post_id;

  perform app.create_notification(
    v_author, 'post_like', new.profile_id, v_post => new.post_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_post_like() from public;

create trigger post_likes_notify
  after insert on public.post_likes
  for each row execute function app.notify_post_like();


create or replace function app.notify_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  if new.parent_id is null then
    select p.author_id into v_recipient
      from public.posts p where p.id = new.post_id;

    perform app.create_notification(
      v_recipient, 'post_comment', new.author_id,
      v_post => new.post_id, v_comment => new.id
    );
  else
    select c.author_id into v_recipient
      from public.comments c where c.id = new.parent_id;

    perform app.create_notification(
      v_recipient, 'comment_reply', new.author_id,
      v_post => new.post_id, v_comment => new.id
    );
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_comment() from public;

create trigger comments_notify
  after insert on public.comments
  for each row execute function app.notify_comment();


create or replace function app.notify_comment_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
  v_post   uuid;
begin
  select c.author_id, c.post_id into v_author, v_post
    from public.comments c where c.id = new.comment_id;

  perform app.create_notification(
    v_author, 'comment_like', new.profile_id,
    v_post => v_post, v_comment => new.comment_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_comment_like() from public;

create trigger comment_likes_notify
  after insert on public.comment_likes
  for each row execute function app.notify_comment_like();


-- =============================================================================
-- Fan-out: projects
-- =============================================================================
create or replace function app.notify_project_star()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select p.owner_id into v_owner
    from public.projects p where p.id = new.project_id;

  perform app.create_notification(
    v_owner, 'project_star', new.profile_id, v_project => new.project_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_project_star() from public;

create trigger project_stars_notify
  after insert on public.project_stars
  for each row execute function app.notify_project_star();


-- Applications go to everyone who can act on them. app.prevent_owner_removal()
-- guarantees the owner has a project_members row, so reading membership alone
-- reaches them.
create or replace function app.notify_project_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
begin
  if tg_op = 'INSERT' then
    for v_manager in
      select m.profile_id
        from public.project_members m
       where m.project_id = new.project_id
         and m.role in ('owner', 'maintainer')
    loop
      perform app.create_notification(
        v_manager, 'project_application', new.applicant_id,
        v_project => new.project_id
      );
    end loop;

  elsif new.status is distinct from old.status then
    if new.status = 'accepted' then
      perform app.create_notification(
        new.applicant_id, 'project_application_accepted', new.reviewed_by,
        v_project => new.project_id
      );
    elsif new.status = 'rejected' then
      perform app.create_notification(
        new.applicant_id, 'project_application_rejected', new.reviewed_by,
        v_project => new.project_id
      );
    end if;
    -- 'withdrawn' is the applicant's own action and notifies nobody.
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_project_application() from public;

create trigger project_applications_notify
  after insert or update of status on public.project_applications
  for each row execute function app.notify_project_application();


create or replace function app.notify_project_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform app.create_notification(
        new.invitee_id, 'project_invite', new.inviter_id,
        v_project => new.project_id
      );
    end if;

  elsif new.status is distinct from old.status then
    if new.status = 'accepted' then
      perform app.create_notification(
        new.inviter_id, 'project_invite_accepted', new.invitee_id,
        v_project => new.project_id
      );
    elsif new.status = 'declined' then
      perform app.create_notification(
        new.inviter_id, 'project_invite_declined', new.invitee_id,
        v_project => new.project_id
      );
    end if;
    -- 'revoked' is the inviter's own action.
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_project_invite() from public;

create trigger project_invites_notify
  after insert or update of status on public.project_invites
  for each row execute function app.notify_project_invite();


-- Existing members are told who joined. The owner's own row, inserted by
-- app.projects_after_insert() when the project is created, notifies nobody --
-- there is nobody else on the team yet, and create_notification would refuse
-- the self-notification anyway.
create or replace function app.notify_project_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid;
begin
  if tg_op = 'INSERT' then
    if new.role <> 'owner' then
      for v_member in
        select m.profile_id
          from public.project_members m
         where m.project_id = new.project_id
           and m.profile_id <> new.profile_id
      loop
        perform app.create_notification(
          v_member, 'project_member_joined', new.profile_id,
          v_project => new.project_id
        );
      end loop;
    end if;

  elsif new.role = 'owner' and old.role is distinct from 'owner' then
    -- Ownership transfer. The actor is left null: the row records who now owns
    -- the project, not who handed it over.
    perform app.create_notification(
      new.profile_id, 'project_ownership_received',
      v_project => new.project_id
    );
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_project_membership() from public;

create trigger project_members_notify
  after insert or update of role on public.project_members
  for each row execute function app.notify_project_membership();


-- =============================================================================
-- Fan-out: ideas
-- =============================================================================
create or replace function app.notify_idea_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select i.author_id into v_author
    from public.ideas i where i.id = new.idea_id;

  perform app.create_notification(
    v_author, 'idea_vote', new.profile_id, v_idea => new.idea_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_idea_vote() from public;

create trigger idea_votes_notify
  after insert on public.idea_votes
  for each row execute function app.notify_idea_vote();


create or replace function app.notify_idea_interest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select i.author_id into v_author
    from public.ideas i where i.id = new.idea_id;

  perform app.create_notification(
    v_author, 'idea_interest', new.profile_id, v_idea => new.idea_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_idea_interest() from public;

create trigger idea_interest_notify
  after insert on public.idea_interest
  for each row execute function app.notify_idea_interest();


create or replace function app.notify_idea_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  select i.author_id into v_author
    from public.ideas i where i.id = new.idea_id;

  perform app.create_notification(
    v_author, 'idea_comment', new.author_id, v_idea => new.idea_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_idea_comment() from public;

create trigger idea_comments_notify
  after insert on public.idea_comments
  for each row execute function app.notify_idea_comment();


-- =============================================================================
-- Fan-out: skills and achievements
-- =============================================================================
create or replace function app.notify_skill_endorsement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.create_notification(
    new.profile_id, 'skill_endorsement', new.endorser_id,
    v_skill => new.skill_id
  );
  return null;
end;
$$;

revoke execute on function app.notify_skill_endorsement() from public;

create trigger profile_skill_endorsements_notify
  after insert on public.profile_skill_endorsements
  for each row execute function app.notify_skill_endorsement();


-- No actor: an achievement is awarded by the database counting something, and
-- naming a person as its cause would be a fiction.
create or replace function app.notify_achievement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.create_notification(
    new.profile_id, 'achievement_awarded',
    v_achievement => new.achievement_key
  );
  return null;
end;
$$;

revoke execute on function app.notify_achievement() from public;

create trigger profile_achievements_notify
  after insert on public.profile_achievements
  for each row execute function app.notify_achievement();


-- =============================================================================
-- Fan-out: messages
--
-- The notification carries the conversation, never the message and never a
-- word of its body. A notification row is readable by its recipient under a
-- policy of its own; copying message text into it would create a second place
-- where private content lives, with a second set of rules to get right.
--
-- 'message' is the one resurfacing type: a new message in a conversation the
-- user has already read about brings the same row back to the top rather than
-- adding another. The per-conversation unread count lives on
-- conversation_participants, which is where the chat list reads it.
--
-- A muted conversation still increments that unread count -- muting means "stop
-- interrupting me", not "hide this from me".
-- =============================================================================
create or replace function app.notify_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  for v_recipient in
    select cp.profile_id
      from public.conversation_participants cp
     where cp.conversation_id = new.conversation_id
       and cp.profile_id <> new.sender_id
       and cp.left_at is null
       and not cp.is_muted
  loop
    perform app.create_notification(
      v_recipient, 'message', new.sender_id,
      v_conversation => new.conversation_id
    );
  end loop;

  return null;
end;
$$;

revoke execute on function app.notify_message() from public;

-- Fires after app.messages_after_insert() has updated the conversation and the
-- unread counts: 'n' sorts after 'a', and same-type row triggers fire in name
-- order. The ordering is not load-bearing today, but a reader should not have
-- to work out whether it is.
create trigger messages_notify
  after insert on public.messages
  for each row execute function app.notify_message();


-- =============================================================================
-- Fan-out: events
--
-- Cancellation reaches everyone who said going or interested. A change of start
-- time reaches only those going, and resurfaces, because the second
-- reschedule matters as much as the first.
-- =============================================================================
create or replace function app.notify_event_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attendee uuid;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    for v_attendee in
      select a.profile_id
        from public.event_attendees a
       where a.event_id = new.id
         and a.status in ('going', 'interested')
    loop
      perform app.create_notification(
        v_attendee, 'event_cancelled', v_event => new.id
      );
    end loop;

  elsif new.starts_at is distinct from old.starts_at
        and new.status = 'scheduled'
  then
    for v_attendee in
      select a.profile_id
        from public.event_attendees a
       where a.event_id = new.id
         and a.status = 'going'
    loop
      perform app.create_notification(
        v_attendee, 'event_rescheduled', v_event => new.id
      );
    end loop;
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_event_change() from public;

create trigger events_notify_change
  after update of status, starts_at on public.events
  for each row execute function app.notify_event_change();


-- =============================================================================
-- Fan-out: moderation
--
-- One function for every moderated table, dispatching on tg_table_name. The
-- alternative is six near-identical functions that drift.
--
-- The actor is always null. Telling a user which moderator hid their post
-- invites retaliation and tells them nothing they can act on; the appeal route
-- is the report, not the person.
--
-- These notifications ignore preferences, because notification_categories marks
-- 'moderation' as not suppressible. A user who has muted everything still finds
-- out that their post was removed.
-- =============================================================================
create or replace function app.notify_content_moderated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if new.moderation_status = old.moderation_status then
    return null;
  end if;

  v_type := case new.moderation_status
              when 'hidden'  then 'content_hidden'
              when 'removed' then 'content_removed'
            end;

  -- Restoring content to 'active' is not something the author needs a
  -- notification for; the content simply reappears.
  if v_type is null then
    return null;
  end if;

  if tg_table_name = 'posts' then
    perform app.create_notification(
      new.author_id, v_type, v_post => new.id
    );
  elsif tg_table_name = 'comments' then
    perform app.create_notification(
      new.author_id, v_type, v_post => new.post_id, v_comment => new.id
    );
  elsif tg_table_name = 'ideas' then
    perform app.create_notification(
      new.author_id, v_type, v_idea => new.id
    );
  elsif tg_table_name = 'idea_comments' then
    perform app.create_notification(
      new.author_id, v_type, v_idea => new.idea_id
    );
  elsif tg_table_name = 'opportunities' then
    perform app.create_notification(
      new.posted_by, v_type, v_opportunity => new.id
    );
  elsif tg_table_name = 'events' then
    perform app.create_notification(
      new.created_by, v_type, v_event => new.id
    );
  elsif tg_table_name = 'messages' then
    perform app.create_notification(
      new.sender_id, v_type, v_conversation => new.conversation_id
    );
  end if;

  return null;
end;
$$;

revoke execute on function app.notify_content_moderated() from public;

create trigger posts_notify_moderated
  after update of moderation_status on public.posts
  for each row execute function app.notify_content_moderated();

create trigger comments_notify_moderated
  after update of moderation_status on public.comments
  for each row execute function app.notify_content_moderated();

create trigger ideas_notify_moderated
  after update of moderation_status on public.ideas
  for each row execute function app.notify_content_moderated();

create trigger idea_comments_notify_moderated
  after update of moderation_status on public.idea_comments
  for each row execute function app.notify_content_moderated();

create trigger opportunities_notify_moderated
  after update of moderation_status on public.opportunities
  for each row execute function app.notify_content_moderated();

create trigger events_notify_moderated
  after update of moderation_status on public.events
  for each row execute function app.notify_content_moderated();

create trigger messages_notify_moderated
  after update of moderation_status on public.messages
  for each row execute function app.notify_content_moderated();


-- =============================================================================
-- Blocking withdraws notifications in both directions
--
-- 0005 already deletes the follow and the connection when a block is created.
-- The notifications those actions produced have to go too, or the blocker keeps
-- a list item naming the person they just blocked -- and can still click
-- through to them from it.
-- =============================================================================
create or replace function app.notifications_after_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.notifications n
   where (n.recipient_id = new.blocker_id and n.actor_id = new.blocked_id)
      or (n.recipient_id = new.blocked_id and n.actor_id = new.blocker_id);

  return null;
end;
$$;

revoke execute on function app.notifications_after_block() from public;

create trigger blocks_notifications_cleanup
  after insert on public.blocks
  for each row execute function app.notifications_after_block();


-- =============================================================================
-- public.dispatch_due_reminders
--
-- ### NOT SCHEDULED BY THIS MIGRATION. ###
--
-- The function works. Nothing calls it. Creating the pg_cron job is a
-- deployment step (DEPLOYMENT.md), and until it is done no reminder is ever
-- sent -- so the product must not advertise reminders. This comment is the
-- honest version of a feature flag.
--
-- Idempotence is the dedupe constraint's job, not a "reminded_at" column's:
-- 'event_reminder' and 'opportunity_deadline' do not resurface, so a second run
-- an hour later creates nothing, and a run that crashes half way can simply be
-- repeated.
--
-- Returns the number of notifications created, so an operator can tell the
-- difference between "nothing was due" and "the job did not run".
-- =============================================================================
create or replace function public.dispatch_due_reminders(
  v_event_window        interval default interval '24 hours',
  v_opportunity_window  interval default interval '48 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     record;
  v_created integer := 0;
begin
  for v_row in
    select a.profile_id, e.id as event_id
      from public.events e
      join public.event_attendees a on a.event_id = e.id
     where e.status = 'scheduled'
       and e.moderation_status = 'active'
       and e.starts_at > now()
       and e.starts_at <= now() + v_event_window
       and a.status = 'going'
  loop
    if app.create_notification(
         v_row.profile_id, 'event_reminder', v_event => v_row.event_id
       ) then
      v_created := v_created + 1;
    end if;
  end loop;

  for v_row in
    select s.profile_id, o.id as opportunity_id
      from public.opportunities o
      join public.opportunity_saves s on s.opportunity_id = o.id
     where o.status = 'open'
       and o.moderation_status = 'active'
       and o.deleted_at is null
       and o.deadline is not null
       and o.deadline > now()
       and o.deadline <= now() + v_opportunity_window
  loop
    if app.create_notification(
         v_row.profile_id, 'opportunity_deadline',
         v_opportunity => v_row.opportunity_id
       ) then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- Not callable by a client. A user triggering the reminder sweep could use it
-- to work out whether a listing they cannot see exists: the return value counts
-- notifications created, so it answers questions about rows the caller cannot
-- read. Both client roles are named explicitly, for the reason given above
-- unread_notification_count().
revoke execute on function public.dispatch_due_reminders(interval, interval)
  from public, anon, authenticated;
grant execute on function public.dispatch_due_reminders(interval, interval) to service_role;


-- =============================================================================
-- Realtime
--
-- Guarded, because the publication is created by the Supabase platform and does
-- not exist in the local test harness. Its absence must not fail the migration.
--
-- Default replica identity is enough: the client subscribes to INSERTs, and an
-- INSERT payload carries the whole new row regardless.
-- =============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.notifications';
    end if;
  end if;
end
$$;
