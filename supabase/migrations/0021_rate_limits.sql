-- =============================================================================
-- 0021_rate_limits.sql
--
-- A Postgres-backed fixed-window rate limiter.
--
-- WHY THE DATABASE AND NOT REDIS
--
-- Rate limiting needs shared state and an atomic increment. A process-local
-- counter cannot provide either on a serverless platform: every request may be a
-- different instance, so the limit becomes "N per instance" and the number in the
-- configuration is a lie. Redis would solve it and would add a third piece of
-- infrastructure to a project that has deliberately chosen to have one database.
-- Postgres already has the atomicity (a single INSERT ... ON CONFLICT DO UPDATE),
-- and at MVP scale a row per (key, identity, window) is not a hot spot.
--
-- ARCHITECTURE §10 states this preference explicitly; this migration is where it
-- stops being a preference. SECURITY.md §8 lists "Rate limiting. 0017_rate_limits
-- is not written" -- the number there was a guess made before 0016 and 0017 were
-- taken by other work, so this is 0021.
--
-- WHY A FIXED WINDOW AND NOT A SLIDING ONE
--
-- The obvious precise answer is a sliding window: keep one row per call and count
-- the rows in the last N seconds. It is exact, and it makes the ledger grow with
-- traffic -- one row per posting, per signup attempt, per report -- which is a
-- table that needs pruning harder than the thing it is protecting, and a COUNT
-- over a range on every request. A fixed window is one row per (key, identity,
-- window) that is incremented in place.
--
-- The cost, stated rather than discovered: a caller can send `limit` requests at
-- the end of one window and `limit` again at the start of the next, so a peak of
-- 2x the limit is possible for one instant per window. For the things this
-- protects -- posting, messaging, reporting, bug reports -- 2x at a boundary is
-- acceptable; the alternative protects against a shape of abuse this product does
-- not have yet. If it ever matters, the fix is a sliding window in the same table,
-- and the interface (a boolean for "are you within your budget") does not change.
--
-- WHY A DENIAL IS NOT AN ERROR
--
-- check_rate_limit() returns boolean rather than raising. The caller decides what
-- a refusal means: the action wrapper turns it into a sentence and does not
-- perform the write. Raising would make "you are posting too fast" indistinguishable
-- from "the database is down" in the one place that has to tell them apart -- and
-- the two need different copy and different logging.
--
-- The exception: an error from this function IS a refusal. src/lib/rate-limit
-- treats a failed check as "not allowed", because the only reason to reach this
-- code is to write something, and the write would need the same database
-- connection anyway. Failing open would mean an outage removes the limit.
--
-- WHY THE LEDGER IS IN `app` AND HAS NO FOREIGN KEY ON THE SUBJECT
--
-- `app` is not exposed through PostgREST, so no client can read this table, and
-- nothing in it is application data. A rate-limit row is operational state about
-- a session.
--
-- There is deliberately no foreign key to profiles. Three reasons, each of them a
-- bug avoided: a cascade would delete the row the moment a profile was deleted,
-- resetting a spammer's budget; a restrict would make a profile undeletable while
-- a single window row existed; and the subject is an authenticated identity, which
-- can exist before any profile row does (auth.users is created first, and 0016
-- exists precisely because a profile can be missing).
--
-- WHAT IS NOT HERE
--
--   Per-IP limits.  The subject is always auth.uid(). There is no trusted source
--                   for a client IP in this application -- a header a client can
--                   set is not an identity -- so an anonymous flood is a
--                   platform-layer concern (Cloudflare or the host), not this.
--   Escalating bans. Three breaches do not mean a longer window. A user who is
--                   abusing a surface is a moderation problem, and the moderation
--                   tools are 0020.
--   Pruning job.    Old windows are removed by a probabilistic sweep inside the
--                   function (below). A pg_cron sweep is the deterministic answer
--                   and belongs in DEPLOYMENT.md with the other scheduled work.
-- =============================================================================


-- =============================================================================
-- app.rate_limit_windows
--
-- One row per (key, identity, window). `hits` is incremented in place, so the
-- table's size is bounded by (number of distinct keys) x (number of active users)
-- rather than by traffic.
-- =============================================================================
create table app.rate_limit_windows (
  -- The surface, e.g. 'report:file' or 'bug:file'. Stable, short, and never
  -- client-supplied: the caller is a Server Action, and the value is a literal in
  -- the action definition.
  bucket text not null check (length(btrim(bucket)) between 1 and 64),

  -- auth.uid(). Not a foreign key -- see the file header.
  subject uuid not null,

  -- The UTC instant the window opens, truncated to a multiple of the window
  -- length. Stored rather than derived so that a later change to a window length
  -- does not retroactively re-interpret existing rows.
  window_start timestamptz not null,

  hits integer not null default 0 check (hits >= 0),

  primary key (bucket, subject, window_start)
);

comment on table app.rate_limit_windows is
  'Fixed-window rate-limit counters. Operational state: no client role has any '
  'privilege on it, and PostgREST does not serve the app schema.';

-- For the sweep below. Without it the delete is a sequential scan of a table that
-- is the largest thing in this schema by design.
create index rate_limit_windows_prune_idx
  on app.rate_limit_windows (window_start);


-- =============================================================================
-- app.check_rate_limit
--
-- The whole limiter: one increment, one comparison. Atomic because the increment
-- and the read are the same statement -- two requests cannot both read "2" and
-- both decide they are under a limit of 3.
--
-- Returns true when the call is within budget. The Nth call in a window succeeds
-- and the N+1th does not, which is the boundary tests/db/moderation.test.ts pins.
-- =============================================================================
create or replace function app.check_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := auth.uid();
  v_window  timestamptz;
  v_hits    integer;
begin
  -- Anonymous visitors have no budget because they have no identity, and a
  -- limit keyed on a value the client chooses (a header, a cookie, a body field)
  -- is not a limit. Every surface this protects requires a session anyway.
  if v_subject is null then
    raise exception 'Rate limiting requires a signed-in caller'
      using errcode = '42501', hint = 'no_subject';
  end if;

  if coalesce(btrim(p_bucket), '') = '' then
    raise exception 'A rate limit needs a bucket name'
      using errcode = '22023', hint = 'bucket_required';
  end if;

  -- Bounds on the parameters, not on the user. A caller that could pass
  -- limit = 1000000 would be passing its own limit. It cannot: the only caller is
  -- a Server Action with the numbers written in its source, and the public
  -- wrapper is not reachable with different numbers from the interface.
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'Limit out of range' using errcode = '22023', hint = 'limit_out_of_range';
  end if;

  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Window out of range' using errcode = '22023', hint = 'window_out_of_range';
  end if;

  -- clock_timestamp(), not now(): now() is the transaction start time, and a
  -- transaction that performs several checks would place them all in the window
  -- that was current when it began.
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into app.rate_limit_windows (bucket, subject, window_start, hits)
  values (btrim(p_bucket), v_subject, v_window, 1)
  on conflict (bucket, subject, window_start)
    do update set hits = app.rate_limit_windows.hits + 1
  returning hits into v_hits;

  -- A probabilistic sweep, so the ledger cannot grow without bound even before
  -- the pg_cron job in DEPLOYMENT.md exists. It is not a correctness mechanism:
  -- no decision depends on it, and a row that survives an extra day costs one
  -- integer. Nothing in the tests depends on it either, which is why a 1%
  -- probability is acceptable here and would not be in the decision path.
  if random() < 0.01 then
    delete from app.rate_limit_windows
     where window_start < clock_timestamp() - interval '1 day';
  end if;

  return v_hits <= p_limit;
end;
$$;

comment on function app.check_rate_limit(text, integer, integer) is
  'Increments the caller''s counter for a bucket and reports whether they are '
  'within budget. Fixed window; the Nth call succeeds, the N+1th does not.';

-- Not executable by any client role, by the rule 0015 states: a function in
-- `app` that no policy or constraint references is reachable only from inside
-- another SECURITY DEFINER function. The public wrapper below is the client's
-- door, and it is the only one.
revoke execute on function app.check_rate_limit(text, integer, integer)
  from public, anon, authenticated;


-- =============================================================================
-- public.check_rate_limit
--
-- The client-reachable door. It takes no identity argument: the subject is
-- auth.uid() inside app.check_rate_limit, so this cannot be pointed at another
-- user's budget -- the same shape as public.unread_notification_count() and
-- public.total_unread_messages(), and for the same reason.
--
-- Granted to `authenticated` and revoked from `anon`. A signed-in user calling
-- this directly can only spend their own budget; the counter only goes up, so
-- knowing the answer does not let anyone past a limit the server enforces with
-- its own bucket name and its own numbers.
-- =============================================================================
create or replace function public.check_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.check_rate_limit(p_bucket, p_limit, p_window_seconds);
end;
$$;

-- `from public` alone would leave the direct grants Supabase's default
-- privileges make to anon and authenticated in place. See 0015: every restricted
-- function names the roles it revokes from.
revoke execute on function public.check_rate_limit(text, integer, integer)
  from public, anon;
grant execute on function public.check_rate_limit(text, integer, integer)
  to authenticated;
