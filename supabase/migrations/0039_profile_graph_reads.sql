-- FINAL INTEGRATION PROPOSAL ONLY, 2026-11-02. Not applied or verified.
-- Intended repository path: supabase/migrations/0039_profile_graph_reads.sql.
-- Current inspected sequence ends at 0038_account_invitation_exports.sql.
-- Main must recheck/reserve 0039 immediately before installing this proposal.
-- Apply through the existing transactional migrator/bundle, never piecemeal.
-- No independent BEGIN/COMMIT: the bundle owns its transaction.
--
-- Requires coordinated removal of raw graph counters from hosted FULL_SELECT
-- and nullable/omitted non-owner connection counts in the application DTO/UI.
-- Applying the grants alone breaks those existing hosted profile reads.
--
-- All public RPCs are SECURITY INVOKER. The one policy helper privately checks
-- provider availability and ordinary access; no staff override, caller-supplied
-- viewer, service-role read path, private helper grant, or publication opt-in.
-- Legacy arbitrary-pair app.are_connected / app.is_blocked_either_way grants
-- remain a separate direct-SQL caveat; this migration does not close them.
-- The separately frozen proposed 0040 restricts the two automatic connection
-- award rows. It is not installed/accepted and adds no RPC or helper. This 0039
-- does not change awards, their policies, or owner-authored achievement posts.
-- See GRAPH-FINAL-SQL-PROPOSAL-20261102.md for coherent integration and risks.

-- Candidate access paths, not measured EXPLAIN/capacity evidence.
create index follows_graph_followers_keyset_idx
  on public.follows (following_id, created_at desc, follower_id desc);
create index follows_graph_following_keyset_idx
  on public.follows (follower_id, created_at desc, following_id desc);
create index connections_graph_requester_keyset_idx
  on public.connections (requester_id, created_at desc, id desc)
  where status = 'accepted';
create index connections_graph_addressee_keyset_idx
  on public.connections (addressee_id, created_at desc, id desc)
  where status = 'accepted';

-- A null peer asks only whether this caller may open the subject's graph.
-- A non-null peer additionally requires a REAL follow in either direction, or
-- a REAL accepted connection owned by the actual caller. Returning true cannot
-- disclose an otherwise hidden arbitrary pair's connection/block predicate.
-- No caller may supply a different viewer or request another's connections.
--
-- This definer is needed for private Auth/deletion state and bilateral blocks,
-- not to bypass profile projection RLS in the public invoker RPCs. Reuse 0032's
-- strict private account predicate WITHOUT changing its EXECUTE grants.
create function app.profile_graph_readable(p_subject uuid, p_peer uuid default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
  v_subject_visibility text;
  v_peer_visibility text;
begin
  if p_subject is null
     or (v_viewer is not null and not app.bulla_image_account_active(v_viewer))
     or not app.bulla_image_account_active(p_subject) then
    return false;
  end if;

  select p.visibility into v_subject_visibility
    from public.profiles p where p.id = p_subject;
  if (p_subject is distinct from v_viewer and v_subject_visibility <> 'public')
     or app.is_blocked_either_way(p_subject, v_viewer) then
    return false;
  end if;
  if p_peer is null then return true; end if;

  if p_peer = p_subject
     or not app.bulla_image_account_active(p_peer)
     or app.is_blocked_either_way(p_peer, v_viewer)
     or app.is_blocked_either_way(p_peer, p_subject) then
    return false;
  end if;

  -- Match only existing graph evidence, not an arbitrary-pair privacy oracle.
  if not exists (
       select 1 from public.follows f
        where (f.follower_id = p_subject and f.following_id = p_peer)
           or (f.follower_id = p_peer and f.following_id = p_subject)
     ) and not (
       v_viewer is not null and p_subject = v_viewer and exists (
         select 1 from public.connections c
          where c.status = 'accepted'
            and c.pair_low = least(p_subject, p_peer)
            and c.pair_high = greatest(p_subject, p_peer)
       )
     ) then
    return false;
  end if;

  select p.visibility into v_peer_visibility
    from public.profiles p where p.id = p_peer;
  -- No private peer, including the private viewer's own edge on a public list.
  if v_peer_visibility = 'private' then return false; end if;
  if p_peer = v_viewer then return true; end if;
  return v_peer_visibility = 'public'
    or (v_peer_visibility = 'university' and app.share_university(v_viewer, p_peer))
    or (v_peer_visibility = 'connections' and app.are_connected(v_viewer, p_peer));
end;
$$;
revoke all on function app.profile_graph_readable(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function app.profile_graph_readable(uuid, uuid)
  to anon, authenticated;
comment on function app.profile_graph_readable(uuid, uuid) is
  'Caller-bound ordinary owner/public graph eligibility. Non-null peers require a real authorized edge; no staff override or other-subject connection probe.';

-- Change SELECT only. Keep mutation policies/grants, immutable columns,
-- counters/achievements, notifications, abuse budgets and lifecycle guards.
--
-- Retain the active follower's OWN raw management row so an existing follow can
-- still be withdrawn after its peer becomes hidden/unavailable. SELECT policies
-- also govern DELETE ... WHERE/RETURNING and INSERT ... ON CONFLICT.
-- This is NOT the list/count cohort: both RPCs below additionally require strict
-- subject+peer eligibility. No foreign private peer is projected by that branch.
alter policy follows_select on public.follows
  to anon, authenticated
  using (
    (follower_id = auth.uid() and follower_id <> following_id
      and app.profile_graph_readable(follower_id, null))
    or app.profile_graph_readable(following_id, follower_id)
    or app.profile_graph_readable(follower_id, following_id)
  );
alter policy connections_select_party on public.connections
  to authenticated
  using (auth.uid() in (requester_id, addressee_id));
alter policy blocks_select_own on public.blocks
  to authenticated
  using (blocker_id = auth.uid());

-- Table SELECT dominates column revocation. Remove it first, also remove any
-- explicit counter-column grant, then regrant the exact existing non-counter
-- column inventory. Preserve pre-existing row privacy and UPDATE restrictions.
revoke select on table public.profiles from public, anon, authenticated;
revoke select (follower_count, following_count, connection_count)
  on table public.profiles from public, anon, authenticated;
grant select (
  id, username, display_name, avatar_url, cover_url, headline, bio,
  university_id, department_id, program_id, degree, semester, graduation_year,
  location, website, github_username, linkedin_url, twitter_username,
  visibility, allow_messages_from, allow_connection_requests, searchable,
  onboarding_completed, onboarding_step,
  status, suspended_until, suspension_reason, warning_count, username_changed_at,
  post_count, project_count, last_active_at, created_at, updated_at, deleted_at
) on table public.profiles to anon, authenticated;

create function public.profile_follow_page(
  p_subject uuid,
  p_direction text,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  headline text,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if p_direction is null or p_direction not in ('followers', 'following') then
    raise exception 'Invalid graph direction'
      using errcode = '22023', hint = 'invalid_graph_direction';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null)
     or (p_after_created_at is not null and not pg_catalog.isfinite(p_after_created_at)) then
    raise exception 'Invalid graph cursor'
      using errcode = '22023', hint = 'invalid_graph_cursor';
  end if;
  if not app.profile_graph_readable(p_subject, null) then return; end if;

  return query
    with edges as (
      select f.follower_id as peer_id, f.created_at as edge_at
        from public.follows f
       where p_direction = 'followers' and f.following_id = p_subject
      union all
      select f.following_id as peer_id, f.created_at as edge_at
        from public.follows f
       where p_direction = 'following' and f.follower_id = p_subject
    ), eligible as (
      -- Projection joins retain caller RLS, even for an assured staff caller.
      select p.id as peer_id, p.username, p.display_name, p.avatar_url, p.headline,
             e.edge_at
        from edges e join public.profiles p on p.id = e.peer_id
       where app.profile_graph_readable(p_subject, p.id)
         -- Stored timestamptz permits infinities; cursor transport does not.
         -- Filter before canonicalization/limit, without repairing owner rows.
         and pg_catalog.isfinite(e.edge_at)
    ), canonical as (
      -- Current PK already rejects duplicates. Be defensive about legacy data,
      -- selecting the newest valid real edge BEFORE continuation/lookahead.
      select distinct on (e.peer_id)
             e.peer_id, e.username, e.display_name, e.avatar_url, e.headline, e.edge_at
        from eligible e order by e.peer_id, e.edge_at desc
    )
    select c.peer_id, c.username, c.display_name, c.avatar_url, c.headline, c.edge_at
      from canonical c
     where p_after_created_at is null
        or (c.edge_at, c.peer_id) < (p_after_created_at, p_after_id)
     order by c.edge_at desc, c.peer_id desc
     limit v_limit + 1;
end;
$$;
revoke all on function public.profile_follow_page(uuid, text, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.profile_follow_page(uuid, text, timestamptz, uuid, integer)
  to anon, authenticated;
comment on function public.profile_follow_page(uuid, text, timestamptz, uuid, integer) is
  'Ordinary owner/public follows; visible peer projection plus finite edge time, default 25/max 50 and one eligible lookahead. No connections mode.';

create function public.my_connection_page(
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns table (
  connection_id uuid,
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  headline text,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if (p_after_created_at is null) <> (p_after_id is null)
     or (p_after_created_at is not null and not pg_catalog.isfinite(p_after_created_at)) then
    raise exception 'Invalid graph cursor'
      using errcode = '22023', hint = 'invalid_graph_cursor';
  end if;
  if not app.profile_graph_readable(v_viewer, null) then return; end if;

  return query
    with edges as (
      select c.id as connection_id, c.addressee_id as peer_id, c.created_at as edge_at
        from public.connections c
       where c.requester_id = v_viewer and c.status = 'accepted'
      union all
      select c.id as connection_id, c.requester_id as peer_id, c.created_at as edge_at
        from public.connections c
       where c.addressee_id = v_viewer and c.requester_id <> v_viewer
         and c.status = 'accepted'
    ), eligible as (
      select e.connection_id, p.id as peer_id, p.username, p.display_name,
             p.avatar_url, p.headline, e.edge_at
        from edges e join public.profiles p on p.id = e.peer_id
       where app.profile_graph_readable(v_viewer, p.id)
         and pg_catalog.isfinite(e.edge_at)
    ), canonical as (
      select distinct on (e.peer_id)
             e.connection_id, e.peer_id, e.username, e.display_name,
             e.avatar_url, e.headline, e.edge_at
        from eligible e
       order by e.peer_id, e.edge_at desc, e.connection_id desc
    )
    select c.connection_id, c.peer_id, c.username, c.display_name,
           c.avatar_url, c.headline, c.edge_at
      from canonical c
     where p_after_created_at is null
        or (c.edge_at, c.connection_id) < (p_after_created_at, p_after_id)
     order by c.edge_at desc, c.connection_id desc
     limit v_limit + 1;
end;
$$;
revoke all on function public.my_connection_page(timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.my_connection_page(timestamptz, uuid, integer)
  to authenticated;
comment on function public.my_connection_page(timestamptz, uuid, integer) is
  'Actual caller own eligible accepted connections only; minimal peer plus real own connection ID/finite time; no subject argument or request message.';

create function public.profile_graph_counts(p_subject uuid)
returns table (
  follower_count bigint,
  following_count bigint,
  connection_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_followers bigint;
  v_following bigint;
  v_connections bigint := null;
begin
  if not app.profile_graph_readable(p_subject, null) then return; end if;

  select count(distinct p.id) into v_followers
    from public.follows f join public.profiles p on p.id = f.follower_id
   where f.following_id = p_subject and app.profile_graph_readable(p_subject, p.id)
     and pg_catalog.isfinite(f.created_at);
  select count(distinct p.id) into v_following
    from public.follows f join public.profiles p on p.id = f.following_id
   where f.follower_id = p_subject and app.profile_graph_readable(p_subject, p.id)
     and pg_catalog.isfinite(f.created_at);

  -- Branch BEFORE any connection-table SELECT. Anon has no connection grant;
  -- another subject's aggregate is null, not an invented zero or hidden total.
  if p_subject = auth.uid() then
    select count(distinct p.id) into v_connections
      from public.connections c join public.profiles p
        on p.id = case when c.requester_id = p_subject
                       then c.addressee_id else c.requester_id end
     where c.status = 'accepted'
       and p_subject in (c.requester_id, c.addressee_id)
       and app.profile_graph_readable(p_subject, p.id)
       and pg_catalog.isfinite(c.created_at);
  end if;
  return query select v_followers, v_following, v_connections;
end;
$$;
revoke all on function public.profile_graph_counts(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.profile_graph_counts(uuid) to anon, authenticated;
comment on function public.profile_graph_counts(uuid) is
  'Exact distinct eligible-peer counts with finite edge times; same cohort as graph pages, unavailable subject gives no row; connection_count is null unless actual owner.';
