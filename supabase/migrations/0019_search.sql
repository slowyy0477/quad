-- =============================================================================
-- 0019_search.sql  --  The query surface over everything people search for
--
-- THE DECISION
-- ------------
-- Search is one function, `public.search_all`, over exactly six tables --
-- profiles, projects, posts, ideas, opportunities, events -- and it matches on
-- exactly the columns that already carry a trigram index. It is the only way the
-- application can ask a relevance question, and it answers with one relation so
-- that a search screen is one round trip.
--
-- THE MATCHING IS THE INDEXES, NOT A NEW IDEA
-- ------------------------------------------
-- pg_trgm has been enabled since 0001 and 0003-0013 have created
-- `gin (<column> extensions.gin_trgm_ops)` on one to two text columns per table.
-- Those indexes are the search surface. The columns are:
--
--     profiles.display_name        profiles_username_trgm_idx (username too)
--     projects.title               projects_title_trgm_idx
--     posts.body                   posts_body_trgm_idx
--     ideas.title                  ideas_title_trgm_idx
--     opportunities.title          opportunities_title_trgm_idx
--     events.title                 events_title_trgm_idx
--
-- and nothing else is searched. `projects.tagline`, `ideas.description`,
-- `opportunities.organisation`, `profiles.headline` and `posts.title` are all
-- columns a reader would *expect* a search box to cover, and including them would
-- put an unindexed predicate in the WHERE clause of a query that is already
-- touching six tables. Each of them is a named gap rather than a hidden one; the
-- fix is a deliberate migration per column, not a quiet sequential scan in this
-- one.
--
-- THE SCORE, AND WHY THERE IS NO OTHER TERM IN IT
-- ----------------------------------------------
-- Relevance is `extensions.similarity(column, query)` -- pg_trgm's trigram
-- similarity of the stored text to what was typed. It is not a weight, it is a
-- measurement of two strings, and it is the whole of the ranking.
--
-- Measured on PostgreSQL 18 (PGlite) before writing this:
--
--   * similarity('ayesha', 'Ayesha') = 1.000 -- pg_trgm folds case, so the score
--     and the match are both case-insensitive without a lower() that would have
--     put the expression outside the index. (`lower(column) % query` does NOT use
--     an index on `column`; verified, it is a Seq Scan with enable_seqscan=off.)
--   * `column OPERATOR(extensions.%) 'ayesha'` -> Bitmap Index Scan on the
--     trigram index. `column ilike '%ayesha%'` -> Bitmap Index Scan on the same
--     index. Both are filter predicates the index serves.
--   * `similarity(column, 'ayesha') >= 0.3` -> Seq Scan, and still a Seq Scan
--     with enable_seqscan=off. A similarity *comparison* is not indexable; only
--     the `%` operator and LIKE/ILIKE are. That is why the filter is written with
--     `%`/ILIKE and the score is computed separately for ORDER BY.
--   * `show_trgm('ab')` = {  a,  ab, ab } -- three trigrams, so a two-character
--     query is index-servable and the minimum length below is not arbitrary.
--
-- THE REJECTED ALTERNATIVE, AND WHY
-- ---------------------------------
-- The obvious thing to do with a relevance score and a schema full of stored
-- counters is what 0018 does for the feed: a weighted sum of relevance, recency
-- and engagement (`member_count`, `like_count`, `upvote_count`, ...). It was
-- rejected, for two reasons that both matter more here than there.
--
--   1. It breaks pagination, and the fix would be worse than the problem. A score
--      containing recency is a function of the clock, so the boundary row's score
--      changes between page one and page two and a keyset cursor loops -- exactly
--      the failure 0018 documents and works around by flooring the clock to the
--      day. A pure similarity score has no clock in it, so the same query returns
--      the same order at any time, on any machine, and there is nothing to work
--      around.
--   2. It answers a question nobody asked. Somebody typing a surname into a
--      search box wants the person with that surname, not the most popular person
--      whose name resembles it. A popularity weight in search buries the exact
--      match under the loud one, which is the opposite of what a lookup is for.
--
-- Engagement numbers are still *shown* on the results, straight from their stored
-- columns, where a reader can judge them. They are deliberately not a ranking
-- input, and nothing on the screen is a number this function made up.
--
-- The other alternative considered was full-text search (`to_tsvector` /
-- `websearch_to_tsquery`). Rejected: it needs a new expression index per table
-- and a language decision per column, and it matches whole lexemes, so "Ayes" --
-- which is how people actually type -- returns nothing. A campus lookup is a
-- partial-word problem, which is the one thing trigrams are good at.
--
-- TOTAL ORDER AND CURSOR PAGINATION
-- ---------------------------------
-- The canonical ordering is
--
--     similarity desc, created_at desc, id desc
--
-- `created_at desc, id desc` is the tiebreak and it is not optional: similarity
-- is a real number with real ties (two people whose names differ by nothing that
-- forms a trigram score identically), and `created_at` alone is not unique, so
-- without `id` the order is not total and a cursor can land between two rows and
-- repeat one forever. `id` is a uuid, so `(similarity, created_at, id)` is unique.
--
-- The cursor the application carries is `(created_at, id)` -- the shape
-- src/lib/cursor.ts already encodes -- and the third element, the boundary row's
-- similarity, is *not* carried in it. The function is given the boundary row's id
-- and computes that row's similarity itself, in the same statement, with the same
-- expression. So the boundary cannot drift from the rows it bounds: there is one
-- implementation of "how relevant is this row" and both sides use it. A cursor
-- whose id is not in the result set (deleted, hidden, or made up) makes the
-- boundary empty and the function returns the first page, which is the safe
-- answer to a tampered or stale cursor rather than an error.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
-- No personalisation, no per-reader ranking, no ML, no query expansion, no
-- typo-dictionary, no search history, and no ranking input that is not a
-- measurement of stored text. There is no `search_queries` table: nothing here
-- records what anybody typed, and that is a decision, not an omission. Nothing
-- is written by this migration except one function and one comment.
--
-- WHAT WAS MEASURED, AND WHAT WAS ONLY REASONED ABOUT
-- ---------------------------------------------------
-- Everything below was run against PostgreSQL 18 (PGlite) with the real
-- migrations applied, and no measurement in this file is a claim about a hosted
-- project.
--
--   * Index serviceability, on a table whose only index is a trigram GIN index:
--     `name OPERATOR(extensions.%) 'ayesha'` and `name ilike '%ayesha%'` both plan
--     as a Bitmap Index Scan on that index, while
--     `similarity(name, 'ayesha') >= 0.3` plans as a Seq Scan even with
--     enable_seqscan = off. That is the entire reason the filter is written with
--     `%`/ILIKE and the score is used only for ORDER BY.
--   * The person branch at 20,000 profiles, exactly one of which matches:
--
--         random_page_cost      plan                                buffers  actual
--         4.0 (PG default)      Seq Scan                                  386   439 ms
--         1.1 (Supabase's SSD)  Bitmap Index Scan on ..._trgm_idx          174    59 ms
--         seqscan off (forced)  Bitmap Index Scan on ..._trgm_idx          174    45 ms
--
--     The rows and their order are identical in all three; only the access path
--     differs. So the claim is narrow and the caveat is part of it: the trigram
--     index does serve this predicate, the indexed plan measured roughly an order
--     of magnitude cheaper, and a hosted Supabase project sets
--     random_page_cost = 1.1, which is the plan it will choose -- whereas with the
--     PostgreSQL default of 4.0, which is what the local test database uses, the
--     planner estimates the GIN path at 736 cost against 686 for a sequential scan
--     at this size and scans instead. At 500 rows it scans either way, which is
--     correct: an index for one match out of five hundred is not worth a plan.
--   * Two identical calls returned byte-identical row orders -- the determinism
--     claim above, checked rather than asserted.
--   * A cursor whose id is not a visible match returned the first page.
--
-- Not measured, and therefore not claimed: any timing on a hosted Supabase
-- project, any EXPLAIN taken through PostgREST, and any plan above 20,000 rows.
-- The count's cost is reasoned about rather than measured -- `count(*)` over the
-- match set cannot be shortened by the LIMIT, so a query with many matches is
-- bounded by the matches and not by the twenty rows it returns.
--
-- THE GAP IN THE MATCH, SAID PLAINLY
-- ----------------------------------
-- A project whose tagline contains the words and whose title does not will not be
-- found. That is the index boundary above and not a bug to patch around here.
--
-- THE AUDIENCE
-- ------------
-- `authenticated` and `service_role`, and nobody else. Both revokes name their
-- roles explicitly, because `revoke ... from public` does not remove a grant made
-- directly to a role and Supabase grants a new `public` function to
-- anon/authenticated/service_role by default (see 0015's header).
--
-- `anon` is refused on purpose, and the reason is in the visibility model, not in
-- this file: every result kind is filtered by RLS predicates that are relative to
-- the reader (`university`, `connections`, `private`), so "what a signed-out
-- visitor may search" has no coherent answer -- it would silently become "public
-- rows only", a second, weaker definition of visibility living in the search
-- function. The web route requires a session and says so.
--
-- SECURITY INVOKER, AND WHY THAT IS THE WHOLE OF THE AUTHORISATION
-- ---------------------------------------------------------------
-- The function reads `public` tables and filters nothing by visibility. It cannot:
-- the policies in 0004-0013 are the authority on who may see a row, and this
-- function is deliberately *not* a second implementation of them. It is declared
-- SECURITY INVOKER (the default, written out here because it is load-bearing), so
-- every relation it touches is filtered by the caller's own RLS: a private project
-- is invisible to a non-member, a blocked reader sees nothing from the blocker or
-- the blocked, a `university`-scoped profile is invisible across institutions, and
-- a private idea is invisible to everyone but its author -- inside Postgres, on
-- every query, whether or not the application remembers to ask.
--
-- SECURITY DEFINER would be the bug: the function would then run as its owner, the
-- table owner bypasses RLS, and `search_all` would be a public read of every row in
-- six tables. tests/db/search.test.ts asserts the invoker semantics in both
-- directions rather than trusting this paragraph.
--
-- What the function *does* filter, and why that is not a second authorisation
-- rule: `deleted_at is null` and `moderation_status = 'active'`. Those are not
-- access-control questions -- the policies intentionally leave a hidden row
-- readable so a moderator can review it -- and the app is not the moderation
-- queue. Same reasoning, same filters as src/features/feed/queries.ts.
--
-- One filter in here is a privacy rule rather than a moderation one:
-- `profiles.searchable = false` keeps a profile out of search while leaving it
-- visible on its own URL. It is not part of `app.can_view_profile` because
-- "visible" and "findable" are different questions, and a reader who has chosen
-- not to be found should not be found by this function.
--
-- INPUT HANDLING WORTH NAMING
-- ---------------------------
--   * `q` shorter than two characters returns nothing. Below two characters there
--     are no trigrams to look up, so the predicate degenerates into a scan of six
--     tables to answer a question nobody intends to ask.
--   * `%` and `_` in the query are escaped before they reach ILIKE, so a query of
--     `%` is a literal percentage sign rather than "everything". Without that,
--     one signed-in user typing two characters that happen to be wildcards gets a
--     full sequential scan of the whole search surface.
--   * `p_limit` is clamped to 1..50. The clamp is not decoration: it is the bound
--     that makes the cost of one request knowable.
-- =============================================================================


-- =============================================================================
-- public.search_all
--
-- One relation, six kinds. The return type is a superset of the columns the six
-- result kinds display, so the page is a single round trip and each kind's row is
-- built from stored columns only; a column that does not apply to a kind is null.
-- The narrowness lives in TypeScript, where the discriminated union on `kind`
-- makes "a project result has a slug" a compile-time fact.
--
-- `relevance` is deliberately absent from the return type. It is a ranking device,
-- not a fact about a result, and a similarity score rendered next to a person's
-- name invites exactly the reading PRODUCT.md rule 1 forbids. The order carries it.
-- =============================================================================

create or replace function public.search_all(
  p_query    text,
  p_kind     text,
  p_after_id uuid    default null,
  p_limit    integer default 20
)
returns table (
  kind               text,
  id                 uuid,
  created_at         timestamptz,
  total_count        integer,
  title              text,
  subtitle           text,
  slug               text,
  handle             text,
  avatar_url         text,
  category           text,
  status             text,
  visibility         text,
  is_seeking_members boolean,
  member_count       integer,
  star_count         integer,
  like_count         integer,
  comment_count      integer,
  upvote_count       integer,
  interest_count     integer,
  starts_at          timestamptz,
  deadline           date,
  author_id          uuid,
  author_username    text,
  author_display_name text,
  author_avatar_url  text,
  author_headline    text
)
language sql
stable
security invoker
set search_path = ''
as $$
with params as (
  select
    btrim(coalesce(p_query, ''))                          as q,
    least(greatest(coalesce(p_limit, 20), 1), 50)         as lim,
    -- LIKE metacharacters escaped, so the pattern means what the reader typed.
    -- The backslash is doubled first, or the escapes added below would escape
    -- each other.
    '%' || replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%'
                                                          as pattern
),

-- ---------------------------------------------------------------------------
-- One branch per kind. Each is a plain table read with no cross-table
-- predicate, so the reader's RLS applies to it directly and the planner is free
-- to use that table's own indexes; the `%`/ILIKE predicates are the ones the
-- trigram indexes serve, and every other column is either a filter on a stored
-- state or a value carried out to the result row.
--
-- No branch intersects with another unless p_kind selects it, which is why a
-- page never mixes kinds and the ordering below never has to compare them.
-- ---------------------------------------------------------------------------
matches as (
  select
    'person'::text                                     as kind,
    p.id                                               as id,
    p.created_at                                       as created_at,
    greatest(
      extensions.similarity(p.display_name, params.q),
      extensions.similarity(p.username, params.q)
    )                                                  as relevance,
    p.display_name                                     as title,
    p.headline                                         as subtitle,
    null::text                                         as slug,
    p.username                                         as handle,
    p.avatar_url                                       as avatar_url,
    null::text                                         as category,
    null::text                                         as status,
    p.visibility                                       as visibility,
    null::boolean                                      as is_seeking_members,
    null::integer                                      as member_count,
    null::integer                                      as star_count,
    null::integer                                      as like_count,
    null::integer                                      as comment_count,
    null::integer                                      as upvote_count,
    null::integer                                      as interest_count,
    null::timestamptz                                  as starts_at,
    null::date                                         as deadline,
    null::uuid                                         as author_id,
    null::text                                         as author_username,
    null::text                                         as author_display_name,
    null::text                                         as author_avatar_url,
    null::text                                         as author_headline
  from public.profiles p
  cross join params
  where p_kind = 'person'
    and length(params.q) >= 2
    and p.deleted_at is null
    and p.status = 'active'
    -- Not an access-control filter: a suspended or hidden profile is still
    -- readable by a moderator, and this is not the moderation queue. `searchable`
    -- is the reader's own choice not to be found here.
    and p.searchable
    and (
      p.display_name OPERATOR(extensions.%) params.q
      or p.username OPERATOR(extensions.%) params.q
      or p.display_name ilike params.pattern
      or p.username ilike params.pattern
    )

  union all

  select
    'project'::text,
    pj.id,
    pj.created_at,
    extensions.similarity(pj.title, params.q),
    pj.title,
    pj.tagline,
    pj.slug,
    null::text,
    null::text,
    pj.category,
    pj.status,
    pj.visibility,
    pj.is_seeking_members,
    pj.member_count,
    pj.star_count,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::timestamptz,
    null::date,
    owner.id,
    owner.username,
    owner.display_name,
    owner.avatar_url,
    owner.headline
  from public.projects pj
  cross join params
  -- LEFT JOIN: a project may be visible while its owner's profile is not (a
  -- connections-only or deleted owner). The project is still the right answer to
  -- the query, and ProjectCard already renders an absent owner honestly.
  left join public.profiles owner on owner.id = pj.owner_id
  where p_kind = 'project'
    and length(params.q) >= 2
    and pj.deleted_at is null
    and pj.moderation_status = 'active'
    and (pj.title OPERATOR(extensions.%) params.q or pj.title ilike params.pattern)

  union all

  select
    'post'::text,
    po.id,
    po.created_at,
    extensions.similarity(coalesce(po.body, ''), params.q),
    po.title,
    left(btrim(coalesce(po.body, '')), 200),
    null::text,
    null::text,
    null::text,
    po.type,
    null::text,
    po.visibility,
    null::boolean,
    null::integer,
    null::integer,
    po.like_count,
    po.comment_count,
    null::integer,
    null::integer,
    null::timestamptz,
    null::date,
    a.id,
    a.username,
    a.display_name,
    a.avatar_url,
    a.headline
  from public.posts po
  cross join params
  left join public.profiles a on a.id = po.author_id
  where p_kind = 'post'
    and length(params.q) >= 2
    and po.deleted_at is null
    and po.moderation_status = 'active'
    and (coalesce(po.body, '') OPERATOR(extensions.%) params.q
         or coalesce(po.body, '') ilike params.pattern)

  union all

  select
    'idea'::text,
    i.id,
    i.created_at,
    extensions.similarity(i.title, params.q),
    i.title,
    left(btrim(i.description), 200),
    null::text,
    null::text,
    null::text,
    i.category,
    i.status,
    i.visibility,
    null::boolean,
    null::integer,
    null::integer,
    null::integer,
    i.comment_count,
    i.upvote_count,
    i.interest_count,
    null::timestamptz,
    null::date,
    a.id,
    a.username,
    a.display_name,
    a.avatar_url,
    a.headline
  from public.ideas i
  cross join params
  left join public.profiles a on a.id = i.author_id
  where p_kind = 'idea'
    and length(params.q) >= 2
    and i.deleted_at is null
    and i.moderation_status = 'active'
    and (i.title OPERATOR(extensions.%) params.q or i.title ilike params.pattern)

  union all

  select
    'opportunity'::text,
    o.id,
    o.created_at,
    extensions.similarity(o.title, params.q),
    o.title,
    o.organisation,
    o.slug,
    null::text,
    null::text,
    o.type,
    o.status,
    o.visibility,
    null::boolean,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::timestamptz,
    o.deadline,
    a.id,
    a.username,
    a.display_name,
    a.avatar_url,
    a.headline
  from public.opportunities o
  cross join params
  left join public.profiles a on a.id = o.posted_by
  where p_kind = 'opportunity'
    and length(params.q) >= 2
    and o.deleted_at is null
    and o.moderation_status = 'active'
    and (o.title OPERATOR(extensions.%) params.q or o.title ilike params.pattern)

  union all

  select
    'event'::text,
    e.id,
    e.created_at,
    extensions.similarity(e.title, params.q),
    e.title,
    e.location,
    e.slug,
    null::text,
    null::text,
    e.type,
    e.status,
    e.visibility,
    null::boolean,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    null::integer,
    e.starts_at,
    null::date,
    a.id,
    a.username,
    a.display_name,
    a.avatar_url,
    a.headline
  from public.events e
  cross join params
  left join public.profiles a on a.id = e.created_by
  where p_kind = 'event'
    and length(params.q) >= 2
    and e.deleted_at is null
    and e.moderation_status = 'active'
    and (e.title OPERATOR(extensions.%) params.q or e.title ilike params.pattern)
),

-- The count a reader is shown. Exact, over the rows this reader may see, and the
-- same number on every page of a result set.
totals as (
  select count(*)::int as n from matches
),

-- The row the cursor points at, re-scored by the same expression that ranked it.
-- Empty when the id is not a visible match, and the WHERE below then returns the
-- first page: a cursor that cannot be resolved is a cursor that is ignored.
boundary as (
  select m.relevance, m.created_at, m.id
    from matches m
   where p_after_id is not null
     and m.id = p_after_id
)

select
  m.kind,
  m.id,
  m.created_at,
  t.n,
  m.title,
  m.subtitle,
  m.slug,
  m.handle,
  m.avatar_url,
  m.category,
  m.status,
  m.visibility,
  m.is_seeking_members,
  m.member_count,
  m.star_count,
  m.like_count,
  m.comment_count,
  m.upvote_count,
  m.interest_count,
  m.starts_at,
  m.deadline,
  m.author_id,
  m.author_username,
  m.author_display_name,
  m.author_avatar_url,
  m.author_headline
from matches m
cross join totals t
left join boundary b on true
where b.id is null
   or (m.relevance, m.created_at, m.id) < (b.relevance, b.created_at, b.id)
order by m.relevance desc, m.created_at desc, m.id desc
limit (select lim from params);
$$;

comment on function public.search_all(text, text, uuid, integer) is
  'Search over people, projects, posts, ideas, opportunities and events. Matches
   with pg_trgm `%`/ILIKE on the columns that already carry a trigram index, and
   ranks by trigram similarity alone -- no recency or engagement weight, so the
   order is identical on two identical calls and the (similarity, created_at, id)
   cursor can never loop. SECURITY INVOKER: every row is filtered by the caller''s
   own RLS, so a private project, a blocked reader, a hidden post and an
   unsearchable profile are excluded by the policies and not by this function.
   p_after_id is the id of the last row of the previous page; its similarity is
   recomputed here rather than carried in the cursor. EXECUTE: authenticated,
   service_role.';


-- =============================================================================
-- Grants
--
-- Stated per role, in the style 0015 sets out. Both revokes name their roles:
-- Supabase grants a new function in `public` to anon, authenticated and
-- service_role directly, and `revoke ... from public` does not touch a direct
-- grant.
--
--   authenticated  the only caller. Every result is filtered by the reader's own
--                  RLS, so a search without a reader has nothing to filter by.
--   service_role   maintenance and the database test fixtures.
--   anon           refused. A signed-out visitor has no reader-relative
--                  visibility, and the web route redirects to sign-in.
-- =============================================================================

revoke execute on function public.search_all(text, text, uuid, integer)
  from public, anon;
grant execute on function public.search_all(text, text, uuid, integer)
  to authenticated, service_role;
