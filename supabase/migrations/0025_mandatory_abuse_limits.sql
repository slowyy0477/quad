-- =============================================================================
-- 0025_mandatory_abuse_limits.sql -- S06
--
-- Write budgets are mandatory, not a cooperative Server Action preflight.
-- AFTER ROW triggers charge accepted INSERTs and semantic UPDATEs, including
-- raw REST, upserts, batches and writes inside authenticated SECURITY DEFINER
-- RPCs. A refusal rolls back the row, counter and all trigger/RPC side effects.
--
-- No trigger-depth/trusted-write GUC bypass: those authorize protected column
-- changes, not extra abuse budget. Only genuine non-client maintenance with no
-- auth.uid() is exempt. Existing RLS, column grants and moderation guards remain.
--
-- Fixed UTC windows allow up to 2N at a boundary. Per-account controls are not
-- per-IP, signup/Sybil protection, a load result or permission to serve JSON data.
-- =============================================================================

-- There is no consume_bucket RPC in the pre-0025 schema. The configurable
-- public.check_rate_limit(text,int,int) is its actual equivalent.
-- Keep its signature/audience for existing actions and generated client types,
-- but change it to a fixed, NON-CONSUMING preflight below. Unknown names and
-- changed parameters are rejected, not accepted as new attacker-owned buckets.

create or replace function app.abuse_budget(p_bucket text)
returns table (hit_limit integer, window_seconds integer)
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  return query
    select limits.hit_limit, limits.window_seconds
      from (values
        ('post:write',             60, 3600),
        ('comment:write',         120, 3600),
        ('reaction:write',        300, 3600),
        ('save:write',            200, 3600),
        ('message:write',          60,   60),
        ('project:write',          30, 3600),
        ('idea:write',             30, 3600),
        ('opportunity:write',      20, 3600),
        ('event:write',            20, 3600),
        ('event:rsvp',            120, 3600),
        ('university:request',      5, 3600),
        ('report:file',            10, 3600),
        ('bug:file',                5, 3600),
        ('bug:triage',             60, 3600),
        ('moderation:decide',     120, 3600),
        ('moderation:university',  60, 3600)
      ) as limits(bucket, hit_limit, window_seconds)
     where limits.bucket = p_bucket;
  if not found then
    raise exception 'Unknown server-owned abuse budget'
      using errcode = '22023', hint = 'unknown_abuse_bucket';
  end if;
end;
$$;

revoke execute on function app.abuse_budget(text)
  from public, anon, authenticated, service_role;

-- Keep 0021's private ledger and existing active windows; changing an API must
-- not reset already-spent report/bug/staff budgets. Explicitly revoke every
-- client table privilege, including permissive inherited/default grants.
revoke all on table app.rate_limit_windows
  from public, anon, authenticated, service_role;

-- Private compatibility signature. Caller parameters may only echo the fixed
-- catalogue, never change its policy. The capped conditional upsert holds the
-- conflicting counter row's lock until the write transaction finishes.
-- N succeeds; N+1 returns false without increasing hits/overflowing an integer.
create or replace function app.check_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := auth.uid();
  v_limit integer;
  v_seconds integer;
  v_window timestamptz;
  v_hits integer;
begin
  if v_subject is null then
    raise exception 'Rate limiting requires a signed-in caller'
      using errcode = '42501', hint = 'no_subject';
  end if;
  select b.hit_limit, b.window_seconds into v_limit, v_seconds
    from app.abuse_budget(p_bucket) b;
  if p_limit is distinct from v_limit
     or p_window_seconds is distinct from v_seconds then
    raise exception 'Abuse budget parameters are server-owned'
      using errcode = '22023', hint = 'fixed_abuse_budget';
  end if;
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_seconds) * v_seconds
  );

  insert into app.rate_limit_windows (bucket, subject, window_start, hits)
  values (p_bucket, v_subject, v_window, 1)
  on conflict (bucket, subject, window_start) do update
    set hits = app.rate_limit_windows.hits + 1
    where app.rate_limit_windows.hits < v_limit
  returning hits into v_hits;

  -- Retain the existing bounded-retention best-effort sweep. Operators still
  -- need a recorded deterministic pruning/recovery procedure before launch.
  if random() < 0.01 then
    delete from app.rate_limit_windows
     where window_start < clock_timestamp() - interval '1 day';
  end if;
  return v_hits is not null;
end;
$$;

revoke execute on function app.check_rate_limit(text, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function public.check_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := auth.uid();
  v_limit integer;
  v_seconds integer;
  v_window timestamptz;
  v_hits integer;
begin
  if v_subject is null then
    raise exception 'Rate limiting requires a signed-in caller'
      using errcode = '42501', hint = 'no_subject';
  end if;
  select b.hit_limit, b.window_seconds into v_limit, v_seconds
    from app.abuse_budget(p_bucket) b;
  if p_limit is distinct from v_limit
     or p_window_seconds is distinct from v_seconds then
    raise exception 'Abuse budget parameters are server-owned'
      using errcode = '22023', hint = 'fixed_abuse_budget';
  end if;
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_seconds) * v_seconds
  );
  select w.hits into v_hits from app.rate_limit_windows w
   where w.bucket = p_bucket and w.subject = v_subject
     and w.window_start = v_window;
  return coalesce(v_hits, 0) < v_limit;
end;
$$;

comment on function public.check_rate_limit(text, integer, integer) is
  'Non-consuming own-account preflight for fixed server budgets. Parameters '
  'must match the server catalogue. A true result is not a write permit; '
  'mandatory row triggers atomically charge the eventual write.';

revoke execute on function public.check_rate_limit(text, integer, integer)
  from public, anon, service_role;
grant execute on function public.check_rate_limit(text, integer, integer)
  to authenticated;

-- The lifecycle migration wraps public DEFINER RPCs by moving them into app.
-- 0021 gave the private consumer the same name/signature as its public wrapper,
-- so that SET SCHEMA would collide. Rename ONLY the private, client-revoked
-- consumer after replacing the public body above. Its fixed contract and ACLs
-- survive; public.check_rate_limit and generated app client types do not change.
alter function app.check_rate_limit(text, integer, integer)
  rename to consume_abuse_budget;
comment on function app.consume_abuse_budget(text, integer, integer) is
  'Owner-only atomic consumer for the fixed server abuse catalogue. Parameters '
  'must match server policy. No client can invoke or enlarge the budget.';
revoke execute on function app.consume_abuse_budget(text, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function app.enforce_abuse_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket text := tg_argv[0];
  v_ignored text[] := array['updated_at', 'is_edited', 'edited_at'];
  v_limit integer;
  v_seconds integer;
begin
  -- Do not use current_user: SECURITY DEFINER would exempt every client.
  -- A client with missing identity fails closed even if future RLS is widened.
  if auth.uid() is null then
    if not app.is_privileged_role() then
      raise exception 'An abuse-limited write requires a signed-in caller'
        using errcode = '42501', hint = 'no_subject';
    end if;
    return null;
  end if;

  -- Derived counters/stamps are not fresh user writes. Comparing a projection,
  -- rather than skipping nested triggers, keeps real nested/RPC writes gated.
  -- The five existing reportable content types deny clients UPDATE on
  -- moderation_status. Their protected moderation effect is charged once by the
  -- report UPDATE in the same transaction, not also by the ordinary write
  -- budget. Do NOT extend that exclusion to boards while their column is still
  -- client-granted in 0013; a later board migration must close that grant first.
  case tg_table_name
    when 'posts' then
      v_ignored := v_ignored || array['like_count', 'comment_count', 'save_count', 'university_id', 'moderation_status'];
    when 'comments' then
      v_ignored := v_ignored || array['like_count', 'reply_count', 'moderation_status'];
    when 'messages' then
      v_ignored := v_ignored || array['moderation_status'];
    when 'projects' then
      v_ignored := v_ignored || array['member_count', 'application_count', 'star_count', 'post_count', 'university_id', 'moderation_status'];
    when 'ideas' then
      v_ignored := v_ignored || array['upvote_count', 'interest_count', 'comment_count', 'university_id', 'moderation_status'];
    when 'opportunities' then
      v_ignored := v_ignored || array['save_count', 'university_id'];
    when 'events' then
      v_ignored := v_ignored || array['attendee_count', 'going_count', 'interested_count', 'university_id'];
    when 'universities' then
      v_ignored := v_ignored || array['student_count', 'project_count', 'normalized_name'];
    else
      null;
  end case;

  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - v_ignored) = (to_jsonb(old) - v_ignored) then
      return null;
    end if;
    -- Staff actions consume the existing wrapper's bucket, not the reporter's
    -- creation budget. The subject remains the verified caller, not row owner.
    if tg_table_name = 'reports' then
      v_bucket := 'moderation:decide';
    elsif tg_table_name = 'bug_reports' then
      v_bucket := 'bug:triage';
    elsif tg_table_name = 'universities' then
      if (to_jsonb(new) -> 'status') is distinct from (to_jsonb(old) -> 'status')
         or (to_jsonb(new) -> 'reviewed_by') is distinct from (to_jsonb(old) -> 'reviewed_by')
         or (to_jsonb(new) -> 'reviewed_at') is distinct from (to_jsonb(old) -> 'reviewed_at') then
        v_bucket := 'moderation:university';
      end if;
    end if;
  end if;

  select b.hit_limit, b.window_seconds into v_limit, v_seconds
    from app.abuse_budget(v_bucket) b;
  if not app.consume_abuse_budget(v_bucket, v_limit, v_seconds) then
    raise exception 'Write refused: rate_limit_exceeded'
      using errcode = 'P0001', hint = 'rate_limit_exceeded';
  end if;
  return null;
end;
$$;

revoke execute on function app.enforce_abuse_budget()
  from public, anon, authenticated, service_role;

-- AFTER INSERT means ON CONFLICT DO NOTHING does not spend a hit, and
-- ON CONFLICT DO UPDATE spends at most one hit for its actual semantic update.
-- Per-row triggers make one oversized REST batch fail in its entirety.
create trigger mandatory_abuse_budget
  after insert or update on public.posts
  for each row execute function app.enforce_abuse_budget('post:write');
create trigger mandatory_abuse_budget
  after insert or update on public.comments
  for each row execute function app.enforce_abuse_budget('comment:write');
create trigger mandatory_abuse_budget
  after insert or update on public.idea_comments
  for each row execute function app.enforce_abuse_budget('comment:write');
create trigger mandatory_abuse_budget
  after insert or update on public.post_likes
  for each row execute function app.enforce_abuse_budget('reaction:write');
create trigger mandatory_abuse_budget
  after insert or update on public.idea_votes
  for each row execute function app.enforce_abuse_budget('reaction:write');
create trigger mandatory_abuse_budget
  after insert or update on public.project_stars
  for each row execute function app.enforce_abuse_budget('reaction:write');
create trigger mandatory_abuse_budget
  after insert or update on public.post_saves
  for each row execute function app.enforce_abuse_budget('save:write');
create trigger mandatory_abuse_budget
  after insert or update on public.opportunity_saves
  for each row execute function app.enforce_abuse_budget('save:write');
create trigger mandatory_abuse_budget
  after insert or update on public.messages
  for each row execute function app.enforce_abuse_budget('message:write');
create trigger mandatory_abuse_budget
  after insert or update on public.projects
  for each row execute function app.enforce_abuse_budget('project:write');
create trigger mandatory_abuse_budget
  after insert or update on public.ideas
  for each row execute function app.enforce_abuse_budget('idea:write');
create trigger mandatory_abuse_budget
  after insert or update on public.opportunities
  for each row execute function app.enforce_abuse_budget('opportunity:write');
create trigger mandatory_abuse_budget
  after insert or update on public.events
  for each row execute function app.enforce_abuse_budget('event:write');
create trigger mandatory_abuse_budget
  after insert or update on public.event_attendees
  for each row execute function app.enforce_abuse_budget('event:rsvp');
create trigger mandatory_abuse_budget
  after insert or update on public.reports
  for each row execute function app.enforce_abuse_budget('report:file');
create trigger mandatory_abuse_budget
  after insert or update on public.universities
  for each row execute function app.enforce_abuse_budget('university:request');
create trigger mandatory_abuse_budget
  after insert or update on public.bug_reports
  for each row execute function app.enforce_abuse_budget('bug:file');

-- No public table write grant was removed or widened. PostgREST has one
-- unchanged authenticated RPC signature; every new helper is owner-only.
