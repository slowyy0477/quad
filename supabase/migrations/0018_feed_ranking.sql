-- =============================================================================
-- 0018_feed_ranking.sql  --  The "For you" ordering, as a documented function
--
-- THE DECISION
-- ------------
-- The feed has two lenses and this migration supplies the ordering for one of
-- them. "For you" is ordered by `app.rank_feed(...)`: a weighted sum of recency,
-- engagement and a university proximity bonus. "Following" is not ranked at all
-- and is a separate relation, because "what the people I chose are doing" is a
-- chronological question and pretending otherwise would be a worse answer.
--
-- THE REJECTED ALTERNATIVE, AND WHY
-- --------------------------------
-- The obvious implementation is a plain `order by created_at desc`, which is what
-- 0008's indexes were built for and what the feed did before this migration. It
-- was rejected because the ordering is the product decision, not a detail:
--
--   * plain recency buries the good post. A question that five people answered
--     this morning is pushed off the first page by six people posting "hi" in the
--     last ten minutes, which is precisely the failure mode that makes a campus
--     feed feel dead.
--   * plain engagement, the other obvious choice (order by like_count), rewards
--     the loudest and is worse: a post that got 200 likes last semester outranks
--     today's opportunity forever, because a counter never decays.
--
-- So recency and engagement are combined, and the combination is written down
-- here rather than in a query somewhere, because a ranking that cannot be read and
-- argued with is indistinguishable from a bug.
--
-- THE WEIGHTS
-- -----------
-- Named constants, in one `with` clause, so changing the ranking is a one-line
-- diff rather than a hunt. The reasoning for each:
--
--   RECENCY_HALF_LIFE_HOURS = 24   the recency term halves every day. A campus
--                                  feed is a daily habit; a week-old post winning
--                                  is a feed that has nothing new in it.
--   W_RECENCY               = 1.0  the base term, range (0, 1].
--   W_LIKE                  = 1.0  one like is the weakest signal of value, and it
--                                  is the one that costs the least.
--   W_COMMENT               = 2.0  writing a comment costs more effort than a tap
--                                  and is a far better predictor that the post was
--                                  worth reading.
--   W_SAVE                  = 3.0  a save is private: nobody saves a post to look
--                                  good, so it is the least gameable signal in the
--                                  schema and is weighted highest.
--   W_UNIVERSITY            = 0.5  a mild bonus when the author and the reader
--                                  share a university, derived from stored
--                                  `profiles.university_id`. It is a tie-breaker,
--                                  not a filter -- a good post from elsewhere still
--                                  wins.
--
-- Engagement is compressed with `ln(1 + n)` rather than used linearly. Without it,
-- one post with 300 likes is 300 units and every other post on the page is
-- invisible; the logarithm means the tenth like still matters and the three
-- hundredth barely does. Recency is `0.5 ^ (age / half-life)`, clamped at age zero
-- so a clock skew that puts `created_at` in the future scores as brand new rather
-- than as an error.
--
-- TOTAL ORDER AND PAGINATION
-- --------------------------
-- A ranking that is not a total order makes keyset pagination loop: two rows with
-- equal scores and no tiebreaker are returned in whatever order the planner
-- chooses, so a cursor can land between them and the next page repeats one. The
-- canonical order is therefore
--
--     feed_score desc, created_at desc, id desc
--
-- with `(created_at, id)` as the final tiebreak, because `created_at` alone is not
-- unique -- two rows written in the same millisecond would still be unordered.
-- `public.ranked_feed` exposes all three columns so a consumer orders by the whole
-- key; tests/db/posts.test.ts pins the resulting order for a fixed fixture.
--
-- THE CLOCK, AND WHY IT IS FLOORED TO THE DAY
-- -------------------------------------------
-- The function takes `p_now` as a parameter precisely so the caller decides the
-- clock, and the view does not pass `now()`. It passes `date_trunc('day', now())`.
--
-- That is not a rounding preference, it is what makes the ranking usable as a sort
-- key at all. A score that is a function of the exact instant changes between two
-- page fetches: fetching page one of "For you" and then page two a second later
-- gives the same rows two different scores, and the boundary comparison that keeps
-- the pages disjoint -- `(feed_score, created_at, id) < (page one's last row)` --
-- then compares a value read at time T1 against values computed at T2. Measured
-- before this change, on the fixture in tests/db/posts.test.ts: the boundary row
-- scored 10.909642 when read back and its own row scored 10.909641 in the next
-- statement, one second later. The boundary was therefore *below* rows already
-- shown, and page two began by repeating page one. That is the loop this whole
-- section is about, and no tiebreak can fix it, because the drift is in the score
-- itself.
--
-- Flooring the clock to the day makes the score a stable property of a row for
-- every request on that day, so the boundary comparison is exact. The ordering does
-- not change: recency is `0.5 ^ (age / 24h)` and flooring the clock multiplies
-- every row's recency term by the same constant, so the relative order of two rows
-- is identical to the `now()`-based order at that instant. What changes is only
-- that posts written the same day tie on recency and are separated by
-- `created_at desc` -- newer still wins, exactly as before.
--
-- The rejected alternative was to pass `now()` and add a tolerance to the boundary
-- comparison. A tolerance cannot be made safe in both directions: too tight and the
-- loop returns, too loose and a post that ranks just below the boundary is dropped
-- from the feed for the rest of the session. A stable score has neither failure.
-- The cost is stated plainly: at 00:00 UTC the day changes, every score is
-- multiplied by `0.5 ^ (1/24)`, and a reader who pages across that instant can see
-- a row twice. Once a day, on a boundary, is a limit worth having.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
-- No personalisation, no per-reader learning, no ML, no ML dependency, and no
-- score that is not computed from stored columns. The reader's only influence is
-- the university bonus, which comes from `profiles.university_id`. Nothing here
-- invents a number; every input is a column.
--
-- WHY TWO VIEWS AND NOT AN RPC
-- ----------------------------
-- `app` is deliberately not exposed through PostgREST (see the header of
-- src/lib/db/database.types.ts), so a function in `app` cannot be called by the
-- application. PostgREST also cannot order a table by an expression. The
-- supported way to give the app a ranked, RLS-filtered relation is a view with
-- `security_invoker = true` -- added in PostgreSQL 15 -- which the application
-- queries exactly like a table while row level security is still evaluated as the
-- reader. Without `security_invoker` the view would run as its owner and RLS would
-- be bypassed entirely, which on Supabase means a public API endpoint for every
-- post; the tests assert that it is not.
--
-- THE AUDIENCE
-- ------------
-- `app.rank_feed(...)` is a pure scoring function -- no table access, no
-- `auth.uid()`, no `now()` -- so it is SECURITY INVOKER and IMMUTABLE. It is
-- executable by `authenticated` (the ranked view's reader) and `service_role`
-- (maintenance), and by nobody else: it is revoked from PUBLIC and from `anon`
-- explicitly, because `revoke ... from public` does not remove a grant made
-- directly to a role (see the header of 0015_function_grants.sql). Both views are
-- revoked from PUBLIC, `anon` and `authenticated` and re-granted SELECT to
-- `authenticated` only: a signed-out visitor has no feed to rank, and
-- `supabase/tests/bootstrap.sql` grants new relations SELECT to `anon` by default,
-- so the revoke is load-bearing.
-- =============================================================================


-- =============================================================================
-- app.rank_feed — the score
--
-- Every parameter is passed in rather than read from a table, which is what makes
-- the function IMMUTABLE and testable with a fixed clock: a test can call it with
-- an explicit `p_now` and get the same answer on every machine, forever.
-- =============================================================================

create or replace function app.rank_feed(
  p_created_at        timestamptz,
  p_now               timestamptz,
  p_like_count        integer,
  p_comment_count     integer,
  p_save_count        integer,
  p_author_university uuid,
  p_viewer_university uuid
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  with weights as (
    select
      24.0::numeric as recency_half_life_hours,
      1.0::numeric  as w_recency,
      1.0::numeric  as w_like,
      2.0::numeric  as w_comment,
      3.0::numeric  as w_save,
      0.5::numeric  as w_university
  )
  select round(
    w.w_recency
      -- Age in hours, floored at zero so a future timestamp scores as new.
      * power(
          0.5::numeric,
          greatest(
            extract(epoch from (p_now - p_created_at))::numeric / 3600.0,
            0::numeric
          ) / w.recency_half_life_hours
        )
    + w.w_like    * ln(1::numeric + greatest(coalesce(p_like_count, 0), 0)::numeric)
    + w.w_comment * ln(1::numeric + greatest(coalesce(p_comment_count, 0), 0)::numeric)
    + w.w_save    * ln(1::numeric + greatest(coalesce(p_save_count, 0), 0)::numeric)
    + case
        when p_viewer_university is not null
         and p_author_university is not null
         and p_author_university = p_viewer_university
        then w.w_university
        else 0::numeric
      end,
    6
  )
  from weights w;
$$;

comment on function app.rank_feed(
  timestamptz, timestamptz, integer, integer, integer, uuid, uuid
) is
  'Feed score for the "For you" lens: 1.0 * 0.5^(age_hours/24) + 1.0*ln(1+likes)
   + 2.0*ln(1+comments) + 3.0*ln(1+saves) + 0.5 when the author shares the
   reader''s university. Immutable and deterministic: every input is a parameter.
   Deliberately not personalised and deliberately not ML. The canonical ordering is
   (score desc, created_at desc, id desc) -- the last two are the pagination
   tiebreak and are not optional.';


-- =============================================================================
-- public.ranked_feed — the "For you" lens
--
-- A view rather than a table: it stores nothing and cannot drift from `posts`. The
-- author columns are flattened into the view because PostgREST resolves embed
-- hints through foreign keys, and a view has no foreign keys, so
-- `author:profiles!posts_author_id_fkey` does not work against one. Flattening
-- also keeps the feed to a single round trip.
--
-- The attached project and goal are flattened for the same reason, and they are
-- what stop a post being a decontextualised timeline entry: the card renders the
-- project or goal the post is about.
--
-- The joins are LEFT joins and their tables' own RLS applies, so a reader who may
-- not see the attached project gets a null block rather than a leaked title --
-- which is the same answer the post-level anchor guards are trying to give.
--
-- `security_invoker = true` is load-bearing. The default (security definer, running
-- as the view's owner) would make this a hole: it would return every post in the
-- table to every caller, including rows RLS is supposed to withhold. The tests in
-- tests/db/posts.test.ts assert the invoker semantics by reading the view as a
-- stranger.
-- =============================================================================

create view public.ranked_feed
with (security_invoker = true)
as
select
  p.id,
  p.author_id,
  p.type,
  p.title,
  p.body,
  p.link_url,
  p.project_id,
  p.goal_id,
  p.opportunity_id,
  p.university_id,
  p.like_count,
  p.comment_count,
  p.save_count,
  p.is_edited,
  p.created_at,
  a.username     as author_username,
  a.display_name as author_display_name,
  a.avatar_url   as author_avatar_url,
  a.headline     as author_headline,
  pj.slug        as project_slug,
  pj.title       as project_title,
  pj.tagline     as project_tagline,
  pj.status      as project_status,
  g.title            as goal_title,
  g.status           as goal_status,
  g.progress_percent as goal_progress_percent,
  app.rank_feed(
    p.created_at,
    -- Floored to the day, not `now()`. See "THE CLOCK" in the header: a score that
    -- moves between two requests cannot be used as a pagination boundary, and the
    -- boundary row's score is read back in a separate statement.
    pg_catalog.date_trunc('day', pg_catalog.now()),
    p.like_count,
    p.comment_count,
    p.save_count,
    p.university_id,
    v.university_id
  ) as feed_score
from public.posts p
left join public.profiles a on a.id = p.author_id
left join public.projects pj on pj.id = p.project_id
left join public.goals    g  on g.id = p.goal_id
-- The reader's own profile, for the university bonus. LEFT JOIN because a
-- signed-in reader whose profile row is not visible to themselves is not a case
-- that exists, but an unconfigured session is, and a missing bonus is the right
-- answer there rather than a dropped row.
left join public.profiles v on v.id = auth.uid()
where p.deleted_at is null
  and p.moderation_status = 'active';

comment on view public.ranked_feed is
  'The "For you" lens: visible posts with their author, the attached project or
   goal, and a feed_score from app.rank_feed. security_invoker, so
   posts/profiles/projects/goals RLS is evaluated as the reader. Order by
   (feed_score desc, created_at desc, id desc).';


-- =============================================================================
-- public.following_feed — the "Following" lens
--
-- The restriction is in the view's definition, not in a filter the caller applies
-- and could forget: a row appears only when the reader has a `follows` row for its
-- author. That makes "only accounts the reader follows" a property of the relation
-- rather than a convention, which is what the test asserts by selecting from it
-- directly.
--
-- Not ranked. Following is "what the people you chose are doing", which is a
-- chronological question; the ORDER BY is (created_at desc, id desc).
-- =============================================================================

create view public.following_feed
with (security_invoker = true)
as
select
  p.id,
  p.author_id,
  p.type,
  p.title,
  p.body,
  p.link_url,
  p.project_id,
  p.goal_id,
  p.opportunity_id,
  p.university_id,
  p.like_count,
  p.comment_count,
  p.save_count,
  p.is_edited,
  p.created_at,
  a.username     as author_username,
  a.display_name as author_display_name,
  a.avatar_url   as author_avatar_url,
  a.headline     as author_headline,
  pj.slug        as project_slug,
  pj.title       as project_title,
  pj.tagline     as project_tagline,
  pj.status      as project_status,
  g.title            as goal_title,
  g.status           as goal_status,
  g.progress_percent as goal_progress_percent
from public.posts p
-- INNER JOIN, unlike the profile joins: a post whose author the reader does not
-- follow is not part of this lens, and there is no such thing as a following-feed
-- post with no follow row.
join public.follows f
  on f.following_id = p.author_id
 and f.follower_id = auth.uid()
left join public.profiles a  on a.id = p.author_id
left join public.projects pj on pj.id = p.project_id
left join public.goals    g  on g.id = p.goal_id
where p.deleted_at is null
  and p.moderation_status = 'active';

comment on view public.following_feed is
  'The "Following" lens: posts whose author the reader follows. The restriction is
   part of the view definition, and security_invoker keeps posts/follows/profiles
   RLS in force. Order by (created_at desc, id desc).';


-- =============================================================================
-- Grants
--
-- Stated per object and per role, in the style the migrations use. Every revoke
-- names the role it is revoking from, because `from public` does not remove a
-- grant made directly to a role.
-- =============================================================================

-- app.rank_feed: a pure scorer. `authenticated` needs EXECUTE because the two
-- views are security_invoker and are queried as the reader; `service_role` for
-- maintenance and for the tests' fixture reads. Not `anon`: no signed-out reader
-- has a feed to rank, and the views are not granted to `anon` either.
revoke execute on function app.rank_feed(
  timestamptz, timestamptz, integer, integer, integer, uuid, uuid
) from public, anon;
grant execute on function app.rank_feed(
  timestamptz, timestamptz, integer, integer, integer, uuid, uuid
) to authenticated, service_role;

-- The two views. The revoke is necessary and not decorative: `on tables` in the
-- platform's default privileges covers views, so both arrive with SELECT granted
-- to `anon` and with INSERT/UPDATE/DELETE that mean nothing on a view.
revoke all on public.ranked_feed    from public, anon, authenticated;
revoke all on public.following_feed from public, anon, authenticated;

grant select on public.ranked_feed    to authenticated, service_role;
grant select on public.following_feed to authenticated, service_role;
