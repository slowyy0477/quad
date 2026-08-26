-- =============================================================================
-- 0005  Social graph: follows, connections, blocks
-- =============================================================================
-- Three distinct relationships, deliberately not collapsed into one table:
--
--   follows      one-directional, no consent, no notification to approve
--   connections  bilateral, requires acceptance, one row per PAIR
--   blocks       one-directional intent, bilateral effect
--
-- Self-relationships and duplicates are prevented by CHECK and UNIQUE
-- constraints, not by application code. A concurrent double-click cannot create
-- two rows (spec §11, §61 "test duplicate requests and race conditions").
-- =============================================================================

-- =============================================================================
-- follows
-- =============================================================================

create table public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  -- Self-follow is impossible at the storage layer (spec §11).
  constraint follows_no_self check (follower_id <> following_id)
);

comment on table public.follows is
  'One-directional. PK doubles as the duplicate guard; a double-click is a no-op.';

create index follows_following_idx on public.follows (following_id, created_at desc);
create index follows_follower_idx  on public.follows (follower_id, created_at desc);


-- =============================================================================
-- blocks   (created before connections: its trigger cleans connection rows)
-- =============================================================================

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  reason     text check (length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

create index blocks_blocked_idx on public.blocks (blocked_id);


-- Bidirectional test. Used by nearly every visibility predicate in the schema,
-- so it is kept to a single indexed lookup.
create or replace function app.is_blocked_either_way(v_a uuid, v_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_a is not null and v_b is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_a and b.blocked_id = v_b)
       or (b.blocker_id = v_b and b.blocked_id = v_a)
  );
$$;

revoke execute on function app.is_blocked_either_way(uuid, uuid) from public;
grant execute on function app.is_blocked_either_way(uuid, uuid)
  to authenticated, anon, service_role;


-- =============================================================================
-- connections
-- =============================================================================

create table public.connections (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,

  status text not null default 'pending'
         check (status in ('pending', 'accepted', 'rejected')),
  message text check (length(message) <= 500),

  -- Ordered pair, populated by trigger. The UNIQUE constraint on these two is
  -- what makes A→B and B→A the same request rather than two competing ones.
  pair_low  uuid not null,
  pair_high uuid not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  responded_at timestamptz,

  constraint connections_no_self check (requester_id <> addressee_id),
  constraint connections_pair_unique unique (pair_low, pair_high)
);

comment on table public.connections is
  'One row per PAIR of users, in any direction. Re-requests reuse the row.';

create index connections_addressee_pending_idx
  on public.connections (addressee_id, created_at desc) where status = 'pending';
create index connections_requester_idx
  on public.connections (requester_id, status);
create index connections_accepted_low_idx
  on public.connections (pair_low)  where status = 'accepted';
create index connections_accepted_high_idx
  on public.connections (pair_high) where status = 'accepted';

create trigger connections_set_updated_at
  before update on public.connections
  for each row execute function app.set_updated_at();


create or replace function app.connections_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- The requester is always the caller. A client cannot forge a request
    -- "from" someone else even if it owns the row it is inserting.
    if not app.is_privileged_role() then
      new.requester_id := auth.uid();
      new.status       := 'pending';
      new.responded_at := null;
    end if;

    if app.is_blocked_either_way(new.requester_id, new.addressee_id) then
      raise exception 'connection is not possible between these users'
        using errcode = '42501', hint = 'blocked';
    end if;

    if not exists (
      select 1 from public.profiles p
      where p.id = new.addressee_id
        and p.allow_connection_requests
        and p.deleted_at is null
        and p.status = 'active'
    ) then
      raise exception 'this student is not accepting connection requests'
        using errcode = '42501', hint = 'requests_disabled';
    end if;
  end if;

  new.pair_low  := least(new.requester_id, new.addressee_id);
  new.pair_high := greatest(new.requester_id, new.addressee_id);

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.responded_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function app.connections_before_write() from public;

create trigger connections_before_write
  before insert or update on public.connections
  for each row execute function app.connections_before_write();


create or replace function app.are_connected(v_a uuid, v_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_a is not null and v_b is not null and exists (
    select 1 from public.connections c
    where c.status = 'accepted'
      and c.pair_low  = least(v_a, v_b)
      and c.pair_high = greatest(v_a, v_b)
  );
$$;

revoke execute on function app.are_connected(uuid, uuid) from public;
grant execute on function app.are_connected(uuid, uuid) to authenticated, anon, service_role;


create or replace function app.share_university(v_a uuid, v_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_a is not null and v_b is not null and exists (
    select 1
    from public.profiles pa
    join public.profiles pb on pb.university_id = pa.university_id
    where pa.id = v_a and pb.id = v_b and pa.university_id is not null
  );
$$;

revoke execute on function app.share_university(uuid, uuid) from public;
grant execute on function app.share_university(uuid, uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- connection_count, follower_count, following_count
-- -----------------------------------------------------------------------------
create or replace function app.sync_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set follower_count = follower_count + 1
      where id = new.following_id;
    update public.profiles set following_count = following_count + 1
      where id = new.follower_id;
  else
    update public.profiles set follower_count = greatest(follower_count - 1, 0)
      where id = old.following_id;
    update public.profiles set following_count = greatest(following_count - 1, 0)
      where id = old.follower_id;
  end if;
  return null;
end;
$$;

revoke execute on function app.sync_follow_counts() from public;

create trigger follows_sync_counts
  after insert or delete on public.follows
  for each row execute function app.sync_follow_counts();


create or replace function app.sync_connection_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_accepted boolean := (tg_op <> 'INSERT' and old.status = 'accepted');
  v_is_accepted  boolean := (tg_op <> 'DELETE' and new.status = 'accepted');
begin
  if v_was_accepted = v_is_accepted then
    return null;
  end if;

  if v_is_accepted then
    update public.profiles set connection_count = connection_count + 1
      where id in (new.requester_id, new.addressee_id);
  else
    update public.profiles set connection_count = greatest(connection_count - 1, 0)
      where id in (old.requester_id, old.addressee_id);
  end if;

  return null;
end;
$$;

revoke execute on function app.sync_connection_counts() from public;

create trigger connections_sync_counts
  after insert or update or delete on public.connections
  for each row execute function app.sync_connection_counts();


-- -----------------------------------------------------------------------------
-- Blocking is not just a filter. It severs the existing relationship, because a
-- block that leaves a live follow edge in place still leaks activity.
-- -----------------------------------------------------------------------------
create or replace function app.blocks_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.follows
   where (follower_id = new.blocker_id and following_id = new.blocked_id)
      or (follower_id = new.blocked_id and following_id = new.blocker_id);

  delete from public.connections
   where pair_low  = least(new.blocker_id, new.blocked_id)
     and pair_high = greatest(new.blocker_id, new.blocked_id);

  return null;
end;
$$;

revoke execute on function app.blocks_after_insert() from public;

create trigger blocks_sever_relationships
  after insert on public.blocks
  for each row execute function app.blocks_after_insert();


create or replace function app.blocks_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_privileged_role() then
    new.blocker_id := auth.uid();
  end if;
  return new;
end;
$$;

revoke execute on function app.blocks_before_insert() from public;

create trigger blocks_before_insert
  before insert on public.blocks
  for each row execute function app.blocks_before_insert();


-- =============================================================================
-- Extend the profile visibility predicate now that the graph exists.
-- =============================================================================
create or replace function app.can_view_profile(v_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = v_profile_id
      and (
        -- Always: yourself, and moderators.
        p.id = auth.uid()
        or app.is_moderator()
        or (
          p.deleted_at is null
          and p.status in ('active', 'suspended')
          and not app.is_blocked_either_way(p.id, auth.uid())
          and (
            p.visibility = 'public'
            or (p.visibility = 'university'
                and app.share_university(p.id, auth.uid()))
            or (p.visibility = 'connections'
                and app.are_connected(p.id, auth.uid()))
          )
        )
      )
  );
$$;


-- =============================================================================
-- RLS
-- =============================================================================

alter table public.follows      enable row level security;
alter table public.connections  enable row level security;
alter table public.blocks       enable row level security;

-- follows: public graph, but only for profiles the viewer may see anyway.
create policy follows_select
  on public.follows for select
  to anon, authenticated
  using (app.can_view_profile(follower_id) and app.can_view_profile(following_id));

create policy follows_insert_self
  on public.follows for insert
  to authenticated
  with check (
    follower_id = auth.uid()
    and not app.is_blocked_either_way(follower_id, following_id)
    and exists (
      select 1 from public.profiles p
      where p.id = following_id and p.deleted_at is null and p.status = 'active'
    )
  );

create policy follows_delete_self
  on public.follows for delete
  to authenticated
  using (follower_id = auth.uid());

revoke all on table public.follows from anon, authenticated;
grant select on table public.follows to anon, authenticated;
grant insert, delete on table public.follows to authenticated;


-- connections: strictly the two parties (and moderators).
create policy connections_select_party
  on public.connections for select
  to authenticated
  using (auth.uid() in (requester_id, addressee_id) or app.is_moderator());

create policy connections_insert_requester
  on public.connections for insert
  to authenticated
  with check (requester_id = auth.uid());

-- The addressee accepts or rejects. The requester may only withdraw, which the
-- app models as DELETE.
create policy connections_update_addressee
  on public.connections for update
  to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid() and status in ('accepted', 'rejected'));

-- Either party can sever: withdraw a pending request, or remove a connection.
create policy connections_delete_party
  on public.connections for delete
  to authenticated
  using (auth.uid() in (requester_id, addressee_id));

revoke all on table public.connections from anon, authenticated;
grant select, insert, delete on table public.connections to authenticated;
grant update (status, updated_at, responded_at) on table public.connections to authenticated;


-- blocks: private to the blocker. The blocked user is never told.
create policy blocks_select_own
  on public.blocks for select
  to authenticated
  using (blocker_id = auth.uid() or app.is_moderator());

create policy blocks_insert_own
  on public.blocks for insert
  to authenticated
  with check (blocker_id = auth.uid());

create policy blocks_delete_own
  on public.blocks for delete
  to authenticated
  using (blocker_id = auth.uid());

revoke all on table public.blocks from anon, authenticated;
grant select, insert, delete on table public.blocks to authenticated;
