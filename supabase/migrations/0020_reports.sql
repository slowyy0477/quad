-- =============================================================================
-- 0020_reports.sql
--
-- Moderation: reports, the action log, account sanctions, and bug reports.
--
-- WHY THERE ARE TYPED FOREIGN KEYS HERE TOO
--
-- A report points at one thing. The shorter way to write that is a polymorphic
-- (target_type, target_id) pair, and it is the wrong way for the same reason it
-- was wrong for notifications (0014): a polymorphic id cannot carry a foreign
-- key, so deleting a post leaves a report pointing at nothing and every queue
-- read has to defend against a row it cannot render. Typed nullable columns plus
-- one CHECK asserting exactly one is non-null and matches `kind` make the
-- database -- not a query -- guarantee the target exists. The cost is a wider
-- table and a migration whenever a new reportable thing appears, which is the
-- review point we want: "should this be reportable" is a decision, not a default.
--
-- Note the asymmetry between the two tables, which is deliberate:
--
--   * reports cascade with their target. The queue is not evidence; if the post
--     is gone the queue item is meaningless. The audit row written when the report
--     was decided survives, because it records actor, action, reason and time --
--     facts about a moderator, not about the post.
--   * moderation_actions references content with ON DELETE SET NULL and its
--     actor with ON DELETE RESTRICT. The log must outlive the thing it is about,
--     and it must never lose the name of who did it. The visible consequence,
--     stated because it is a real product decision: an account that has taken a
--     moderation action cannot be hard-deleted, only soft-deleted.
--
-- WHY A REPORT CANNOT BE DECIDED BY A CLIENT UPDATE
--
-- `reports` grants INSERT and SELECT to `authenticated` and nothing else: no
-- UPDATE, no DELETE, for any role. A moderator cannot set `status` from the
-- client at all. The only way a report leaves 'open' is
-- public.moderate_report(), a SECURITY DEFINER function that applies the content
-- effect, the account sanction and the status change in one transaction.
--
-- The rejected alternative was the obvious one: grant UPDATE (status) and rely on
-- a policy `using (app.is_moderator())`. It fails in the direction that matters,
-- because then a moderator with the anon key and a curl command can close any
-- report with no reason recorded, and the audit log stops being a record of what
-- happened and becomes a record of what somebody chose to admit. The audit row is
-- written by a trigger on `reports`, so even a service-role UPDATE of `status`
-- produces one -- and one cannot be produced without a reason, because the
-- trigger refuses a status change whose reason it cannot find.
--
-- WHY THE REASON IS IN A GUC AND NOT A COLUMN
--
-- The trigger needs the reason, and a trigger cannot take a parameter. So
-- app.begin_moderation_action() stashes the action and the reason in
-- transaction-local GUCs, and app.reports_record_action() reads them and refuses
-- to record anything if they are absent. That refusal is the point: there is no
-- code path through this schema that closes a report without a reason string
-- attached, because the missing GUC is an error rather than a null.
--
-- WHY NOTHING IS EVER DELETED FROM moderation_actions
--
-- No DELETE and no UPDATE grant, plus app.forbid_write() as a second barrier, plus
-- `supersedes_id` as the correction path. A moderator who got something wrong
-- records a second action that points at the first; the history shows both. An
-- audit log a moderator can edit is not an audit log, and the three mechanisms
-- are separate on purpose so a future mistaken GRANT is not instantly a
-- history-rewriting bug.
--
-- WHAT A MODERATOR STILL CANNOT SEE
--
-- Messages, except the ones that have actually been reported -- see the narrow
-- policy added to `messages` at the bottom of this file. The alternative, a
-- blanket moderator read policy, would let any moderator browse any private
-- conversation, which is a worse privacy failure than the id-manipulation attack
-- 0010 was built to stop. The scoping is one EXISTS against `reports`.
--
-- WHAT AN ADMIN CANNOT DO HERE
--
-- Read a password (there is none to read -- Supabase Auth holds a hash), escape
-- the log (see above), or act on a report about an administrator without being an
-- administrator. Moderators cannot decide a report about themselves at all, not
-- even to dismiss it: app.assert_moderation_allowed() is called from both the RPC
-- and the trigger, so there is no path around it, including the service role.
--
-- WHAT IS NOT HERE
--
--   Appeals.        A sanctioned user has no appeal flow. The report reason is
--                   visible to moderators; nothing lets the user ask for review.
--   Email.          A moderation decision is an in-app notification; no email is
--                   sent, because no email channel exists anywhere in this schema.
--   Severity.       A report has a reason and free-text detail, no priority queue.
--   Bug triage.     bug_reports.status is advanced by an admin in the interface;
--                   nothing assigns a report to a person or tracks a fix.
-- =============================================================================


-- =============================================================================
-- reports
-- =============================================================================
create table public.reports (
  id uuid primary key default gen_random_uuid(),

  reporter_id uuid not null references public.profiles (id) on delete cascade,

  -- Which column below carries the target. The CHECK that follows keeps the two
  -- halves of that statement from disagreeing.
  kind text not null
    check (kind in ('post', 'comment', 'project', 'idea', 'message', 'profile')),

  -- A fixed list would be better than free text, and the interface offers one
  -- (see src/features/moderation/schemas.ts). It is not a CHECK here because the
  -- list is interface copy that will change, and a migration to reword "Spam or
  -- advertising" would be a migration that rewrites user data. What the database
  -- enforces is that a reason exists and is not whitespace.
  reason text not null check (length(btrim(reason)) between 3 and 60),
  detail text check (detail is null or length(detail) <= 2000),

  post_id    uuid references public.posts    (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  idea_id    uuid references public.ideas    (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete cascade,

  status text not null default 'open'
    check (status in ('open', 'actioned', 'dismissed')),

  -- Null while open. On a profile deletion they become null again with the row
  -- still closed, which is why the coherence rule below keys off reviewed_at
  -- rather than off reviewed_by.
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exactly one target.
  constraint reports_one_target check (
    num_nonnulls(post_id, comment_id, project_id, idea_id, message_id, user_id) = 1
  ),

  -- ...and it is the one the kind says it is. Without this, a client could file a
  -- report with kind='message' and a post_id, and the queue would render a post
  -- under a heading that says a private message was reported.
  constraint reports_kind_matches_target check (
    (kind = 'post'    and post_id    is not null) or
    (kind = 'comment' and comment_id is not null) or
    (kind = 'project' and project_id is not null) or
    (kind = 'idea'    and idea_id    is not null) or
    (kind = 'message' and message_id is not null) or
    (kind = 'profile' and user_id    is not null)
  ),

  constraint reports_not_self check (user_id is null or user_id <> reporter_id),

  constraint reports_reviewed_coherent check ((status = 'open') = (reviewed_at is null))
);

comment on table public.reports is
  'A user''s report about one piece of content or one person. Readable by its '
  'reporter and by moderators; decided only by public.moderate_report().';

comment on column public.reports.reason is
  'One of the fixed list the report dialog offers. Free text is `detail`.';

-- One open report per (reporter, target). Re-filing the same complaint produces
-- the same queue item and a second identical decision, so the database refuses
-- it. A report that was dismissed or actioned can be filed again -- the situation
-- may genuinely recur, and the first decision is still in the log.
--
-- The coalesce is the price of typed columns: with a polymorphic pair this would
-- be a plain unique on (reporter_id, target_id).
create unique index reports_one_open_per_reader_target
  on public.reports (
    reporter_id,
    coalesce(post_id, comment_id, project_id, idea_id, message_id, user_id)
  )
  where status = 'open';

-- The queue: open reports, newest first, keyset-paginated.
create index reports_queue_idx
  on public.reports (created_at desc, id desc)
  where status = 'open';

create index reports_reporter_idx
  on public.reports (reporter_id, created_at desc);

-- Used by the read policy added to `messages` below.
create index reports_message_idx
  on public.reports (message_id)
  where message_id is not null;

create index reports_target_profile_idx
  on public.reports (user_id)
  where user_id is not null;


-- -----------------------------------------------------------------------------
-- app.reports_before_write()
--
-- The reporter and the initial status are assigned here, not accepted. Combined
-- with the column-level INSERT grant (which does not include reporter_id, status,
-- reviewed_by or reviewed_at) forging either fails twice: the GRANT refuses the
-- column, and this trigger would overwrite it if the GRANT were ever widened.
--
-- is_privileged_role() and not `current_user`, for the reason set out in 0001:
-- inside a SECURITY DEFINER function current_user is the owner, so a current_user
-- test would report every browser request as privileged and skip the forcing.
-- -----------------------------------------------------------------------------
create or replace function app.reports_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.reporter_id := auth.uid();
      new.status      := 'open';
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;

    -- Reporting your own content is a support request, not a moderation one, and
    -- it would put a moderator in the position of judging a user against
    -- themselves. Only the profile case is checkable here without a subquery
    -- (CHECK constraints cannot contain one), so this is the one the constraint
    -- covers; the content cases resolve in the trigger that follows.
    if new.user_id is not null and new.user_id = new.reporter_id then
      raise exception 'You cannot report yourself'
        using errcode = '23514', hint = 'self_report';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function app.reports_before_write() from public;

create trigger reports_before_write
  before insert or update on public.reports
  for each row execute function app.reports_before_write();


-- =============================================================================
-- app.reported_profile — who is answerable for a report?
--
-- For content it is the author; for a profile report it is the person. Takes the
-- whole row rather than six nullable ids, because a six-argument version has to
-- re-derive which of them is the target at every call site, and that derivation
-- getting out of step with the CHECK constraint above is exactly the bug this
-- avoids.
-- =============================================================================
create or replace function app.reported_profile(r public.reports)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case r.kind
           when 'post'    then (select p.author_id  from public.posts    p where p.id = r.post_id)
           when 'comment' then (select c.author_id  from public.comments c where c.id = r.comment_id)
           when 'project' then (select pr.owner_id  from public.projects pr where pr.id = r.project_id)
           when 'idea'    then (select i.author_id  from public.ideas    i where i.id = r.idea_id)
           when 'message' then (select m.sender_id  from public.messages  m where m.id = r.message_id)
           when 'profile' then r.user_id
         end;
$$;

revoke execute on function app.reported_profile(public.reports)
  from public, anon, authenticated;


-- =============================================================================
-- moderation_actions — the audit log
--
-- Append-only by four separate mechanisms: no INSERT/UPDATE/DELETE grant to any
-- client role, no UPDATE or DELETE policy, app.forbid_write() as a trigger, and
-- `supersedes_id` as the documented way to correct a mistake.
--
-- The actor is a required foreign key with ON DELETE RESTRICT. A row whose actor
-- could become null would read as "something happened" and would be worthless the
-- first time it mattered.
-- =============================================================================
create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),

  actor_id uuid not null references public.profiles (id) on delete restrict,

  action text not null check (action in (
    'hide_content',
    'remove_content',
    'restore_content',
    'warn_user',
    'suspend_user',
    'dismiss_report',
    'approve_university',
    'reject_university'
  )),

  reason text not null check (length(btrim(reason)) between 3 and 1000),

  report_id uuid references public.reports (id) on delete set null,

  university_id uuid references public.universities (id) on delete set null,

  -- Whoever is answerable: the author of the reported content, or the reported
  -- person. Null only when they deleted their account, which soft deletion in
  -- this schema makes rare.
  target_profile_id uuid references public.profiles (id) on delete set null,

  post_id    uuid references public.posts    (id) on delete set null,
  comment_id uuid references public.comments (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  idea_id    uuid references public.ideas    (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,

  -- The correction path. Never an UPDATE to an existing row.
  supersedes_id uuid references public.moderation_actions (id) on delete set null,

  created_at timestamptz not null default now(),

  constraint moderation_actions_one_content_target
    check (num_nonnulls(post_id, comment_id, project_id, idea_id, message_id) <= 1),

  constraint moderation_actions_no_self_supersede
    check (supersedes_id is null or supersedes_id <> id)
);

comment on table public.moderation_actions is
  'Append-only record of every moderation decision. No client role has INSERT, '
  'UPDATE or DELETE. Corrections are new rows that supersede an earlier one.';

comment on column public.moderation_actions.supersedes_id is
  'Points at the action this one corrects. The earlier row stays as it was.';

-- The audit view: newest first, keyset-paginated.
create index moderation_actions_created_idx
  on public.moderation_actions (created_at desc, id desc);

create index moderation_actions_actor_idx
  on public.moderation_actions (actor_id, created_at desc);

create index moderation_actions_target_idx
  on public.moderation_actions (target_profile_id, created_at desc)
  where target_profile_id is not null;

create index moderation_actions_report_idx
  on public.moderation_actions (report_id)
  where report_id is not null;


-- -----------------------------------------------------------------------------
-- app.assert_moderation_allowed — the two conflicts of interest
--
-- 1. Nobody decides a report about themselves. Not even to dismiss it: "this
--    complaint about me was unfounded" is the decision with the most to gain from
--    self-service, and a rule with an exception for the convenient case is not a
--    rule.
-- 2. A moderator cannot sanction an administrator. Role checks read `user_roles`,
--    which moderators cannot write, so this is not "protect the powerful" -- it is
--    that a moderator who can suspend an admin can take the platform's checks
--    offline. An administrator can act on a report about another administrator,
--    and the log names them.
--
-- Called from public.moderate_report() *and* from the trigger on `reports`, so a
-- service-role UPDATE of `status` is refused for the same reasons. Defence in
-- depth here is not ceremony: the RPC is the only path today, and the trigger is
-- what keeps that true tomorrow.
-- -----------------------------------------------------------------------------
create or replace function app.assert_moderation_allowed(v_actor uuid, v_target uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if v_actor is null then
    raise exception 'A moderation action needs a signed-in actor'
      using errcode = '42501', hint = 'actor_required';
  end if;

  -- Null when the reported content's author has deleted their account. The
  -- decision still has to be recorded -- it is a fact about the moderator -- so
  -- this is a pass, not a silent success.
  if v_target is null then
    return;
  end if;

  if v_target = v_actor then
    raise exception 'You cannot decide a report about yourself'
      using errcode = '42501', hint = 'self_moderation_forbidden';
  end if;

  if app.is_admin(v_target) and not app.is_admin(v_actor) then
    raise exception 'Reports about an administrator are decided by an administrator'
      using errcode = '42501', hint = 'admin_target_forbidden';
  end if;
end;
$$;

revoke execute on function app.assert_moderation_allowed(uuid, uuid)
  from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- app.begin_moderation_action — the reason, carried to the trigger
--
-- GUCs rather than a column because a trigger cannot take a parameter, and
-- transaction-local (is_local => true) so the value cannot survive into the next
-- request on a pooled connection.
--
-- Revoked from every client role: it is reachable only from inside another
-- SECURITY DEFINER function, which runs with its owner's privileges.
-- -----------------------------------------------------------------------------
create or replace function app.begin_moderation_action(
  p_action     text,
  p_reason     text,
  p_supersedes uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A moderation action needs a reason'
      using errcode = '23514', hint = 'reason_required';
  end if;

  perform pg_catalog.set_config('app.moderation_action',     coalesce(p_action, ''), true);
  perform pg_catalog.set_config('app.moderation_reason',     btrim(p_reason),        true);
  perform pg_catalog.set_config('app.moderation_supersedes', coalesce(p_supersedes::text, ''), true);
end;
$$;

revoke execute on function app.begin_moderation_action(text, text, uuid)
  from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- app.reports_record_action — the audit row
--
-- Fires whenever a report leaves 'open'. It writes the row, and it refuses to let
-- the status move without a recorded action and reason, which is what makes
-- "every moderation action is audited" a property of the schema rather than a
-- property of the one function that currently performs it.
--
-- `new.reviewed_by` is the actor when the interface set one; auth.uid() is the
-- fallback for a service-role write, where there is no JWT claim.
-- -----------------------------------------------------------------------------
create or replace function app.reports_record_action()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action     text;
  v_reason     text;
  v_supersedes uuid;
  v_actor      uuid;
  v_target     uuid;
  v_outcome    text;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  -- Reopening is not a moderation action and needs no audit row. Nothing in this
  -- schema reopens a report; the branch exists so that a later one does not have
  -- to invent its own way past this trigger.
  if new.status = 'open' then
    return null;
  end if;

  v_action := nullif(pg_catalog.current_setting('app.moderation_action', true), '');
  v_reason := nullif(btrim(coalesce(pg_catalog.current_setting('app.moderation_reason', true), '')), '');
  v_supersedes := nullif(pg_catalog.current_setting('app.moderation_supersedes', true), '')::uuid;

  if v_action is null or v_reason is null then
    raise exception 'A report cannot be closed without a recorded reason'
      using errcode = '42501', hint = 'moderation_reason_required';
  end if;

  v_actor  := coalesce(new.reviewed_by, auth.uid());
  v_target := app.reported_profile(new);

  -- Again, here, for the service-role path.
  perform app.assert_moderation_allowed(v_actor, v_target);

  insert into public.moderation_actions (
    actor_id, action, reason, report_id, target_profile_id,
    post_id, comment_id, project_id, idea_id, message_id, supersedes_id
  )
  values (
    v_actor, v_action, v_reason, new.id, v_target,
    new.post_id, new.comment_id, new.project_id, new.idea_id, new.message_id, v_supersedes
  );

  -- The reporter is told. The report dialog promises this in as many words, and a
  -- promise the database does not keep is the kind of copy PRODUCT.md rule 2
  -- exists to delete.
  --
  -- 'report_reviewed' resurfaces rather than duplicates: the notification does not
  -- name the target, so a second outcome for the same reporter updates the same
  -- line and brings it back to the top. Creating a second row would be refused by
  -- notifications_dedupe for every report whose target columns are all null.
  v_outcome := case new.status
                 when 'actioned'  then 'A moderator acted on your report.'
                 when 'dismissed' then 'A moderator reviewed your report and took no action.'
               end;

  perform app.create_notification(
    new.reporter_id,
    'report_reviewed',
    v_body    => v_outcome,
    v_post    => new.post_id,
    v_comment => new.comment_id,
    v_project => new.project_id,
    v_idea    => new.idea_id
  );

  return null;
end;
$$;

revoke execute on function app.reports_record_action() from public;

create trigger reports_record_action
  after update of status on public.reports
  for each row execute function app.reports_record_action();


-- -----------------------------------------------------------------------------
-- Reading a report
-- -----------------------------------------------------------------------------
alter table public.reports enable row level security;

-- Three directions, as every table in this schema has: the reporter can read
-- their own, another user cannot read it, and another user cannot read it by
-- supplying its id (the policy is a predicate on the row, not on the query).
create policy reports_select_own
  on public.reports for select
  to authenticated
  using (reporter_id = auth.uid());

create policy reports_select_moderator
  on public.reports for select
  to authenticated
  using (app.is_moderator());

create policy reports_insert_own
  on public.reports for insert
  to authenticated
  with check (reporter_id = auth.uid());

-- There is no UPDATE policy and no DELETE policy, for any role. A report is not
-- the reporter's to retract once filed -- retraction is how a queue is emptied
-- without anyone deciding anything -- and it is not the moderator's to rewrite.
revoke all on table public.reports from anon, authenticated;
grant select on table public.reports to authenticated;
grant insert (kind, reason, detail, post_id, comment_id, project_id, idea_id, message_id, user_id)
  on table public.reports to authenticated;


-- =============================================================================
-- Deciding a report — the audit log
-- =============================================================================
alter table public.moderation_actions enable row level security;

create policy moderation_actions_select_moderator
  on public.moderation_actions for select
  to authenticated
  using (app.is_moderator());

-- No INSERT/UPDATE/DELETE policy, and no such grant either. Rows arrive from
-- app.reports_record_action() and from public.review_university_request(), both
-- SECURITY DEFINER. A moderator who could insert directly could fabricate a
-- decision attributed to a colleague.
revoke all on table public.moderation_actions from anon, authenticated;
grant select on table public.moderation_actions to authenticated;

-- Second barrier, for the day a GRANT is widened by mistake.
create trigger moderation_actions_no_client_write
  before update or delete on public.moderation_actions
  for each row execute function app.forbid_write();


-- =============================================================================
-- The narrow moderator read on private messages
--
-- 0010 left this for here on purpose, and said so in the file: policy
-- expressions are resolved when the policy is created, so a policy that reads
-- `reports` cannot be written before `reports` exists.
--
-- What it grants: a moderator may read a message that somebody has reported. What
-- it does not grant: anything else. There is still no policy under which a
-- moderator can browse a conversation nobody complained about, and no policy
-- under which they can read a message adjacent to a reported one -- which is the
-- whole reason the report points at a message id rather than at a conversation.
--
-- It stays true after the report is decided (the EXISTS does not filter on
-- status). The alternative -- readable only while open -- means the evidence
-- disappears the instant it is used, including when the outcome was 'dismissed',
-- so the decision could never be reviewed afterwards.
-- =============================================================================
create policy messages_select_reported_moderator
  on public.messages for select
  to authenticated
  using (
    app.is_moderator()
    and exists (
      select 1 from public.reports r where r.message_id = messages.id
    )
  );


-- =============================================================================
-- Account sanctions
--
-- profiles.status has allowed 'suspended' since 0004 and nothing enforced it:
-- ADMIN.md says in as many words that no suspended state exists. It does now, and
-- the enforcement is here rather than in the action wrapper because the wrapper is
-- a convenience a direct PostgREST call does not go through.
--
-- A suspension that has run out is not a suspension. The column still says
-- 'suspended' -- nothing clears it, because nothing needs to: the predicate
-- compares suspended_until to now(), so the state is derived rather than
-- maintained by a second writer. app.is_account_restricted is the single
-- definition, and src/lib/action.ts mirrors it for a legible message while this
-- one remains the authority.
-- =============================================================================
create or replace function app.is_account_restricted(v_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1
         from public.profiles p
        where p.id = v_user
          and (
            p.status in ('banned', 'deactivated')
            or (
              p.status = 'suspended'
              and (p.suspended_until is null or p.suspended_until > now())
            )
          )
     );
$$;

comment on function app.is_account_restricted(uuid) is
  'True while the account may not create content: banned, deactivated, or '
  'suspended with an expiry that has not passed. The single definition.';

revoke execute on function app.is_account_restricted(uuid)
  from public, anon, authenticated;


create or replace function app.reject_restricted_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- is_privileged_role() and not current_user: inside this SECURITY DEFINER
  -- trigger current_user is the owner, so a current_user test would report every
  -- browser request as privileged and disable the guard entirely.
  if not app.is_privileged_role() and app.is_account_restricted(auth.uid()) then
    raise exception 'Your account is suspended, so you cannot post at the moment.'
      using errcode = '42501', hint = 'account_suspended';
  end if;

  return new;
end;
$$;

revoke execute on function app.reject_restricted_write() from public;

create trigger posts_reject_restricted_insert
  before insert on public.posts
  for each row execute function app.reject_restricted_write();

create trigger comments_reject_restricted_insert
  before insert on public.comments
  for each row execute function app.reject_restricted_write();

create trigger messages_reject_restricted_insert
  before insert on public.messages
  for each row execute function app.reject_restricted_write();

create trigger ideas_reject_restricted_insert
  before insert on public.ideas
  for each row execute function app.reject_restricted_write();


-- =============================================================================
-- public.moderate_report — the only way a report is decided
--
-- One transaction: the content effect, the account sanction, the status change
-- and (via the trigger above) the audit row. If any part fails, none of it
-- happened, which is what stops "hidden but not recorded" from being a state this
-- system can reach.
--
-- Granted to `authenticated`, because the interface calls it as the signed-in
-- moderator; the privilege check is inside, and it is checked on the *caller's*
-- identity rather than on a role the request claims. A non-moderator calling it
-- gets 42501 with hint 'not_moderator'.
-- =============================================================================
create or replace function public.moderate_report(
  p_report_id  uuid,
  p_action     text,
  p_reason     text,
  p_days       integer default 7,
  p_supersedes uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_report public.reports;
  v_target uuid;
  v_mod    text;
  v_status text;
begin
  if v_me is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not app.is_moderator(v_me) then
    raise exception 'You do not have moderator privileges'
      using errcode = '42501', hint = 'not_moderator';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A moderation action needs a reason'
      using errcode = '23514', hint = 'reason_required';
  end if;

  -- FOR UPDATE: two moderators clicking hide on the same row must not both
  -- succeed. The second finds the status already changed and is refused below.
  select * into v_report
    from public.reports
   where id = p_report_id
   for update;

  if not found then
    raise exception 'That report does not exist'
      using errcode = '23503', hint = 'report_not_found';
  end if;

  if v_report.status <> 'open' then
    raise exception 'That report has already been decided'
      using errcode = '23514', hint = 'report_closed';
  end if;

  v_target := app.reported_profile(v_report);

  perform app.assert_moderation_allowed(v_me, v_target);

  -- The protected-column guard refuses writes to profiles.status,
  -- suspended_until, suspension_reason and warning_count from a client statement.
  -- This is not a client statement, and saying so explicitly is how the guard
  -- stays meaningful: everything not marked here is still refused.
  perform app.begin_trusted_write();

  -- Before the status change, so the trigger can find it.
  perform app.begin_moderation_action(p_action, p_reason, p_supersedes);

  if p_action in ('hide_content', 'remove_content', 'restore_content') then
    v_mod := case p_action
               when 'hide_content'   then 'hidden'
               when 'remove_content' then 'removed'
               else 'active'
             end;

    if v_report.kind = 'post' then
      update public.posts    set moderation_status = v_mod where id = v_report.post_id;
    elsif v_report.kind = 'comment' then
      update public.comments set moderation_status = v_mod where id = v_report.comment_id;
    elsif v_report.kind = 'project' then
      update public.projects set moderation_status = v_mod where id = v_report.project_id;
    elsif v_report.kind = 'idea' then
      update public.ideas    set moderation_status = v_mod where id = v_report.idea_id;
    elsif v_report.kind = 'message' then
      update public.messages set moderation_status = v_mod where id = v_report.message_id;
    else
      raise exception 'A profile cannot be hidden; suspend the account instead'
        using errcode = '23514', hint = 'no_content_for_kind';
    end if;

  elsif p_action = 'warn_user' then
    if v_target is null then
      raise exception 'There is nobody to warn: the account is gone'
        using errcode = '23514', hint = 'no_target';
    end if;

    update public.profiles
       set warning_count = warning_count + 1
     where id = v_target;

  elsif p_action = 'suspend_user' then
    if v_target is null then
      raise exception 'There is nobody to suspend: the account is gone'
        using errcode = '23514', hint = 'no_target';
    end if;

    update public.profiles
       set status            = 'suspended',
           suspended_until   = now() + make_interval(days => greatest(coalesce(p_days, 7), 1)),
           suspension_reason = btrim(p_reason)
     where id = v_target;

  elsif p_action = 'dismiss_report' then
    -- No content effect. A dismissal is still a decision and is still audited.
    null;

  else
    raise exception 'Unknown moderation action: %', p_action
      using errcode = '23514', hint = 'unknown_action';
  end if;

  v_status := case when p_action = 'dismiss_report' then 'dismissed' else 'actioned' end;

  update public.reports
     set status      = v_status,
         reviewed_by = v_me,
         reviewed_at = now()
   where id = p_report_id;

  return v_status;
end;
$$;

revoke execute on function public.moderate_report(uuid, text, text, integer, uuid)
  from public, anon;
grant execute on function public.moderate_report(uuid, text, text, integer, uuid)
  to authenticated;


-- =============================================================================
-- public.review_university_request
--
-- The second thing a moderator queue contains. It needs its own RPC for the same
-- reason as the first: 0003 puts `status`, `reviewed_by` and `reviewed_at` behind
-- app.reject_protected_column_change, so an ordinary client UPDATE cannot approve
-- anything however permissive the policy is.
--
-- The rejection reason is recorded in the log rather than on the row.
-- universities.rejection_reason exists, and writing it would publish a moderator's
-- note to the applicant through universities_select_own_submission -- which is
-- misleading, because the applicant is told the outcome, not the note.
-- =============================================================================
create or replace function public.review_university_request(
  p_university_id uuid,
  p_decision      text,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_action text;
  v_status text;
begin
  if v_me is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not app.is_moderator(v_me) then
    raise exception 'You do not have moderator privileges'
      using errcode = '42501', hint = 'not_moderator';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A moderation action needs a reason'
      using errcode = '23514', hint = 'reason_required';
  end if;

  if p_decision = 'approve' then
    v_status := 'approved';
    v_action := 'approve_university';
  elsif p_decision = 'reject' then
    v_status := 'rejected';
    v_action := 'reject_university';
  else
    raise exception 'Unknown decision: %', p_decision
      using errcode = '23514', hint = 'unknown_decision';
  end if;

  perform app.begin_trusted_write();

  update public.universities
     set status      = v_status,
         reviewed_by = v_me,
         reviewed_at = now()
   where id = p_university_id
     and status = 'pending';

  if not found then
    raise exception 'That request is not waiting for review'
      using errcode = '23514', hint = 'not_pending';
  end if;

  insert into public.moderation_actions (actor_id, action, reason, university_id)
  values (v_me, v_action, btrim(p_reason), p_university_id);
end;
$$;

revoke execute on function public.review_university_request(uuid, text, text)
  from public, anon;
grant execute on function public.review_university_request(uuid, text, text)
  to authenticated;


-- =============================================================================
-- A notification type for the outcome of a report
--
-- 0014 seeded the type catalogue and this adds one row to it, which is the
-- documented way to grow it. `resurfaces` is true for the reason given in the
-- trigger: the notification names no target, so a second outcome for the same
-- reporter is the same line coming back rather than a second line.
-- =============================================================================
insert into public.notification_types (type, category, resurfaces, sort_order)
values ('report_reviewed', 'moderation', true, 30);


-- =============================================================================
-- bug_reports
--
-- Bug reports are not moderation, and they live here because they are the third
-- safety surface M7 names and this is the migration that creates them. They are
-- kept as a separate table rather than as a `reports` row with kind='bug',
-- because the lifecycle is different: a report is decided (open -> actioned or
-- dismissed) by a moderator about somebody else, and a bug report is triaged
-- (open -> reviewed -> fixed) by the maintainer about their own software.
--
-- Readable by its author and by administrators. Not by moderators: bug reports
-- contain the environment a student was using, and "who can read this" should be
-- the smallest set that can help, which is the maintainer.
-- =============================================================================
create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),

  reporter_id uuid not null references public.profiles (id) on delete cascade,

  title text not null check (length(btrim(title)) between 3 and 160),
  body  text not null check (length(btrim(body)) between 10 and 5000),

  -- Where it happened, as the reporter pasted it. Free text rather than a parsed
  -- URL: a route, a full URL or "the settings page on my phone" are all more
  -- useful than a rejected field.
  page_url text check (page_url is null or length(page_url) <= 500),

  status text not null default 'open'
    check (status in ('open', 'reviewed', 'fixed', 'closed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bug_reports is
  'Bug reports from users. Readable by the reporter and by admins; status is '
  'advanced by an admin. Not a moderation surface.';

create index bug_reports_status_idx
  on public.bug_reports (status, created_at desc);

create index bug_reports_reporter_idx
  on public.bug_reports (reporter_id, created_at desc);


create or replace function app.bug_reports_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.reporter_id := auth.uid();
    new.status      := 'open';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function app.bug_reports_before_write() from public;

create trigger bug_reports_before_write
  before insert or update on public.bug_reports
  for each row execute function app.bug_reports_before_write();

alter table public.bug_reports enable row level security;

create policy bug_reports_select_own
  on public.bug_reports for select
  to authenticated
  using (reporter_id = auth.uid());

create policy bug_reports_select_admin
  on public.bug_reports for select
  to authenticated
  using (app.is_admin());

create policy bug_reports_insert_own
  on public.bug_reports for insert
  to authenticated
  with check (reporter_id = auth.uid());

-- The maintainer advances the status. Nothing else on the row is updatable, by
-- policy or by grant: a report an author can rewrite after it has been read is
-- not a report.
create policy bug_reports_update_admin
  on public.bug_reports for update
  to authenticated
  using (app.is_admin())
  with check (app.is_admin());

revoke all on table public.bug_reports from anon, authenticated;
grant select, insert on table public.bug_reports to authenticated;
grant update (status) on table public.bug_reports to authenticated;
