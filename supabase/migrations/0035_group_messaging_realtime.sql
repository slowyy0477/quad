-- 0035 — Bounded, reachable group membership and authorized reconciliation.
-- Forward source only. No live migration, historical role inference or broad
-- grants. 0034 belongs to staff assurance and is intentionally untouched.
--
-- Add/re-add is immediate membership, NOT a pending invitation. The acting admin
-- must be an accepted connection whom the candidate currently accepts DMs from.
-- A readable/live candidate and no either-way block with ANY recorded member
-- are required. Existing memberships are grandfathered, not rewritten when a
-- DM preference changes. Group messages still follow membership, not DM prefs.
--
-- Limits: 10 candidate IDs/request, 20 active and 50 recorded members/group.
-- Larger legacy groups remain readable/manageable; new additions obey limits.
-- 0024's separate history intervals remain the only message-history predicate.

create function app.message_group_account_available(v_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select v_user is not null
    and exists (select 1 from auth.users u where u.id = v_user and u.deleted_at is null)
    and exists (select 1 from public.profiles p where p.id = v_user and p.deleted_at is null)
    and not app.is_account_restricted(v_user)
    and not app.account_deletion_pending(v_user);
$$;
revoke execute on function app.message_group_account_available(uuid)
  from public, anon, authenticated, service_role;

create function app.message_group_reachable(
  v_conversation uuid, v_actor uuid, v_candidate uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select v_actor = auth.uid()
    and v_actor is distinct from v_candidate
    and app.message_group_account_available(v_actor)
    and app.message_group_account_available(v_candidate)
    and app.are_connected(v_actor, v_candidate)
    and app.can_message(v_actor, v_candidate)
    -- Deliberately do not use can_view_profile's staff override as consent.
    and exists (
      select 1 from public.profiles p where p.id = v_candidate and (
        p.visibility = 'public'
        or (p.visibility = 'university' and app.share_university(v_actor, v_candidate))
        or (p.visibility = 'connections' and app.are_connected(v_actor, v_candidate))
      )
    )
    and not exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = v_conversation
        and app.is_blocked_either_way(p.profile_id, v_candidate)
    );
$$;
revoke execute on function app.message_group_reachable(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- VOLATILE: after acquiring the conversation lock, re-read actual authority and
-- admin counts rather than trusting a client/RLS preflight snapshot. RPCs acquire
-- this lock before participant DML; direct INSERT/UPDATE guards acquire it too.
-- Independent hosted transactions/deadlock/retry behavior still need acceptance.
create function app.message_group_require_admin(v_conversation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.conversations c
    where c.id = v_conversation and c.type = 'group' for update;
  if not found or not app.account_lifecycle_access()
     or not app.message_group_account_available(auth.uid())
     or not exists (
       select 1 from public.conversation_participants p
       where p.conversation_id = v_conversation and p.profile_id = auth.uid()
         and p.role = 'admin' and p.left_at is null and p.joined_at <= clock_timestamp()
     )
     or exists (
       select 1 from public.conversation_participants p
       where p.conversation_id = v_conversation
         and app.is_blocked_either_way(auth.uid(), p.profile_id)
     ) then
    raise exception 'Only a current active group admin may do that'
      using errcode = '42501', hint = 'group_admin_required';
  end if;
end;
$$;
revoke execute on function app.message_group_require_admin(uuid)
  from public, anon, authenticated, service_role;

create function app.message_group_participant_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_count integer;
begin
  -- Maintenance has no human JWT subject. A staff role is NOT this bypass.
  if app.is_privileged_role() and auth.uid() is null then return new; end if;
  select c.type into v_type from public.conversations c
    where c.id = new.conversation_id;
  if v_type is distinct from 'group' then return new; end if;

  -- Counter/read/mute-only changes retain their existing grants/guards and do not
  -- contend on a group lock. Only actual membership/role changes enter this path.
  if tg_op = 'UPDATE' and new.role is not distinct from old.role
     and new.left_at is not distinct from old.left_at then return new; end if;

  perform 1 from public.conversations c where c.id = new.conversation_id for update;
  if not app.account_lifecycle_access()
     or not app.message_group_account_available(auth.uid()) then
    raise exception 'Account is unavailable'
      using errcode = '42501', hint = 'account_unavailable';
  end if;

  if tg_op = 'INSERT' then
    select count(*) into v_count from public.conversation_participants p
      where p.conversation_id = new.conversation_id;
    -- The sole bootstrap is the RPC's first founder row in an empty group.
    -- Direct clients still fail the existing INSERT RLS (no active admin yet).
    if v_count = 0 and new.profile_id = auth.uid() and new.role = 'admin'
       and app.is_marked_trusted_write()
       and exists (select 1 from public.conversations c
         where c.id = new.conversation_id and c.created_by = auth.uid()) then
      return new;
    end if;
    perform app.message_group_require_admin(new.conversation_id);
    if new.role <> 'member'
       or not app.message_group_reachable(new.conversation_id, auth.uid(), new.profile_id) then
      raise exception 'This person cannot be added under the group reachability rule'
        using errcode = '42501', hint = 'group_member_not_reachable';
    end if;
    if v_count >= 50 or (select count(*) from public.conversation_participants p
       where p.conversation_id = new.conversation_id and p.left_at is null) >= 20 then
      raise exception 'The group member limit was reached'
        using errcode = '23514', hint = 'group_member_limit';
    end if;
  else
    -- Own leave is still permitted without general management/read permission.
    -- Role changes, other-member removal and re-add require a FRESH active admin.
    if new.role is distinct from old.role or old.profile_id <> auth.uid()
       or (old.left_at is not null and new.left_at is null) then
      perform app.message_group_require_admin(new.conversation_id);
    elsif not exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = old.conversation_id and p.profile_id = auth.uid()
        and p.left_at is null and p.joined_at <= clock_timestamp()
    ) then
      raise exception 'Not an active participant'
        using errcode = '42501', hint = 'not_participant';
    end if;

    if old.left_at is not null and new.left_at is null then
      if not app.message_group_reachable(new.conversation_id, auth.uid(), new.profile_id) then
        raise exception 'This person cannot be added under the group reachability rule'
          using errcode = '42501', hint = 'group_member_not_reachable';
      end if;
      if (select count(*) from public.conversation_participants p
          where p.conversation_id = new.conversation_id and p.left_at is null) >= 20 then
        raise exception 'The group member limit was reached'
          using errcode = '23514', hint = 'group_member_limit';
      end if;
      -- 0024 already archives the old cutoff and normalizes this new join time.
      -- A departed administrator comes back as a member, not as an implicit admin.
      new.role := 'member';
    elsif new.role is distinct from old.role
       and (old.left_at is not null or not app.message_group_account_available(new.profile_id)) then
      raise exception 'Only an active available member may receive a role'
        using errcode = '42501', hint = 'group_member_inactive';
    end if;

    if old.left_at is null and old.role = 'admin'
       and (new.left_at is not null or new.role <> 'admin')
       and not exists (
         select 1 from public.conversation_participants p
         where p.conversation_id = old.conversation_id and p.profile_id <> old.profile_id
           and p.role = 'admin' and p.left_at is null and p.joined_at <= clock_timestamp()
           and app.message_group_account_available(p.profile_id)
       ) then
      raise exception 'The final active group admin must promote another active member first'
        using errcode = '42501', hint = 'final_group_admin';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function app.message_group_participant_guard()
  from public, anon, authenticated, service_role;

-- Alphabetically AFTER 0024's before_write normalization, BEFORE identity guards.
create trigger conversation_participants_group_guard
  before insert or update on public.conversation_participants
  for each row execute function app.message_group_participant_guard();

-- Match the local/history contract: a recorded member's either-way block makes
-- the group unavailable, not just a block against a currently active recipient.
create function app.message_group_send_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app.is_privileged_role() and auth.uid() is null then return new; end if;
  if exists (select 1 from public.conversations c
      where c.id = new.conversation_id and c.type = 'group')
     and exists (select 1 from public.conversation_participants p
      where p.conversation_id = new.conversation_id
        and app.is_blocked_either_way(new.sender_id, p.profile_id)) then
    raise exception 'Group messaging is blocked' using errcode = '42501', hint = 'blocked';
  end if;
  return new;
end;
$$;
revoke execute on function app.message_group_send_guard()
  from public, anon, authenticated, service_role;
create trigger messages_group_guard before insert on public.messages
  for each row execute function app.message_group_send_guard();

create function app.message_group_create(p_title text, p_members uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
  v_member uuid;
  v_added integer := 0;
  v_skipped integer := 0;
begin
  if not app.account_lifecycle_access() or not app.message_group_account_available(v_me) then
    raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  if length(coalesce(btrim(p_title), '')) not between 1 and 120 then
    raise exception 'A group needs a name of at most 120 characters'
      using errcode = '23514', hint = 'title_required';
  end if;
  if coalesce(cardinality(p_members), 0) not between 1 and 10
     or array_ndims(p_members) is distinct from 1 then
    raise exception 'Use one to ten candidate members'
      using errcode = '23514', hint = 'too_many_members';
  end if;
  insert into public.conversations(type, title, created_by)
    values ('group', btrim(p_title), v_me) returning id into v_conv;
  perform app.begin_trusted_write();
  insert into public.conversation_participants(conversation_id, profile_id, role)
    values (v_conv, v_me, 'admin');
  for v_member in select distinct candidate from unnest(p_members) candidate loop
    if coalesce(app.message_group_reachable(v_conv, v_me, v_member), false) then
      insert into public.conversation_participants(conversation_id, profile_id, role)
        values (v_conv, v_member, 'member');
      v_added := v_added + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  if v_added = 0 then
    -- The exception rolls back the empty conversation/founder too.
    raise exception 'No reachable members; no group was created'
      using errcode = '42501', hint = 'group_no_reachable_members';
  end if;
  return jsonb_build_object('conversation_id', v_conv, 'added', v_added, 'skipped', v_skipped);
end;
$$;
revoke execute on function app.message_group_create(text, uuid[])
  from public, anon, authenticated, service_role;

create function public.message_create_group(p_title text, p_members uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app.message_group_create(p_title, p_members);
end;
$$;
revoke execute on function public.message_create_group(text, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.message_create_group(text, uuid[]) to authenticated;

-- Keep the old signature, but not its weak consent bypass or silent skip result.
-- An old client cannot display skip counts, so ANY skip is an atomic refusal.
-- Empty/oversized old requests also refuse. Existing group rows are untouched.
create or replace function public.create_group_conversation(p_title text, p_members uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  v_result := app.message_group_create(p_title, p_members);
  if (v_result->>'skipped')::integer > 0 then
    raise exception 'Some people could not be added; no group was created'
      using errcode = '42501', hint = 'group_member_not_reachable';
  end if;
  return (v_result->>'conversation_id')::uuid;
end;
$$;
-- Retain its existing authenticated audience. The obsolete owner-only 0026
-- body also delegates to the strict wrapper; it is not another creation path.
create or replace function app.account_previous_create_group_conversation(
  p_title text, p_members uuid[] default '{}'
)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.create_group_conversation(p_title, p_members);
end;
$$;
revoke execute on function app.account_previous_create_group_conversation(text, uuid[])
  from public, anon, authenticated, service_role;

create function public.message_add_group_members(p_conversation_id uuid, p_members uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_member uuid;
  v_existing public.conversation_participants;
  v_added integer := 0;
  v_skipped integer := 0;
begin
  perform app.message_group_require_admin(p_conversation_id);
  if coalesce(cardinality(p_members), 0) > 10
     or (cardinality(p_members) > 0 and array_ndims(p_members) is distinct from 1) then
    raise exception 'Use at most ten candidate members'
      using errcode = '23514', hint = 'too_many_members';
  end if;
  for v_member in select distinct candidate from unnest(coalesce(p_members, '{}'::uuid[])) candidate loop
    select * into v_existing from public.conversation_participants p
      where p.conversation_id = p_conversation_id and p.profile_id = v_member;
    if (v_existing.profile_id is not null and v_existing.left_at is null)
       or not coalesce(app.message_group_reachable(p_conversation_id, auth.uid(), v_member), false)
       or (select count(*) from public.conversation_participants p
           where p.conversation_id = p_conversation_id and p.left_at is null) >= 20
       or (v_existing.profile_id is null and
           (select count(*) from public.conversation_participants p
            where p.conversation_id = p_conversation_id) >= 50) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_existing.profile_id is null then
      insert into public.conversation_participants(conversation_id, profile_id, role)
        values (p_conversation_id, v_member, 'member');
    else
      update public.conversation_participants set left_at = null, role = 'member'
        where conversation_id = p_conversation_id and profile_id = v_member;
    end if;
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end;
$$;
revoke execute on function public.message_add_group_members(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.message_add_group_members(uuid, uuid[]) to authenticated;

create function public.message_set_group_role(p_conversation_id uuid, p_profile_id uuid, p_role text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform app.message_group_require_admin(p_conversation_id);
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Invalid group role' using errcode = '23514', hint = 'group_member_inactive';
  end if;
  if not app.message_group_account_available(p_profile_id) then
    raise exception 'Member unavailable' using errcode = '42501', hint = 'group_member_inactive';
  end if;
  update public.conversation_participants set role = p_role
    where conversation_id = p_conversation_id and profile_id = p_profile_id and left_at is null;
  if not found then
    raise exception 'Member unavailable' using errcode = '42501', hint = 'group_member_inactive';
  end if;
  return true;
end;
$$;
revoke execute on function public.message_set_group_role(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.message_set_group_role(uuid, uuid, text) to authenticated;

create function public.message_remove_group_member(p_conversation_id uuid, p_profile_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform app.message_group_require_admin(p_conversation_id);
  update public.conversation_participants set left_at = clock_timestamp()
    where conversation_id = p_conversation_id and profile_id = p_profile_id and left_at is null;
  if not found then
    raise exception 'Member unavailable' using errcode = '42501', hint = 'group_member_inactive';
  end if;
  return true;
end;
$$;
revoke execute on function public.message_remove_group_member(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.message_remove_group_member(uuid, uuid) to authenticated;

create function public.message_leave_conversation(p_conversation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.conversations c where c.id = p_conversation_id for update;
  if not found or not app.account_lifecycle_access()
     or not app.message_group_account_available(auth.uid())
     or not app.is_conversation_participant(p_conversation_id) then
    raise exception 'Not an active participant' using errcode = '42501', hint = 'not_participant';
  end if;
  update public.conversation_participants set left_at = clock_timestamp()
    where conversation_id = p_conversation_id and profile_id = auth.uid() and left_at is null;
  if not found then
    raise exception 'Not an active participant' using errcode = '42501', hint = 'not_participant';
  end if;
  return true;
end;
$$;
revoke execute on function public.message_leave_conversation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.message_leave_conversation(uuid) to authenticated;

create function public.message_group_members(p_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text; v_rows jsonb;
begin
  if not app.account_lifecycle_access() or not app.message_group_account_available(auth.uid())
     or not exists (select 1 from public.conversations c
       where c.id = p_conversation_id and c.type = 'group')
     or not app.is_conversation_participant(p_conversation_id)
     or exists (select 1 from public.conversation_participants p
       where p.conversation_id = p_conversation_id
         and app.is_blocked_either_way(auth.uid(), p.profile_id)) then
    raise exception 'Group unavailable' using errcode = '42501', hint = 'not_participant';
  end if;
  select p.role into v_role from public.conversation_participants p
    where p.conversation_id = p_conversation_id and p.profile_id = auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object(
    'profile_id', p.profile_id, 'role', p.role, 'left', p.left_at is not null,
    'available', app.message_group_account_available(p.profile_id),
    'profile', case when app.can_view_profile(p.profile_id) then (
      select jsonb_build_object('id', profile.id, 'username', profile.username,
        'display_name', profile.display_name, 'avatar_url', profile.avatar_url)
        from public.profiles profile where profile.id = p.profile_id
    ) else null end
  ) order by p.left_at is not null, p.role = 'admin' desc, p.profile_id), '[]'::jsonb)
  into v_rows from (
    select * from public.conversation_participants member
    where member.conversation_id = p_conversation_id
    order by member.left_at is not null, member.role = 'admin' desc, member.profile_id limit 50
  ) p;
  return jsonb_build_object(
    'role', v_role, 'members', v_rows,
    'active_count', (select count(*) from public.conversation_participants p
      where p.conversation_id = p_conversation_id and p.left_at is null),
    'admin_count', (select count(*) from public.conversation_participants p
      where p.conversation_id = p_conversation_id and p.role = 'admin' and p.left_at is null
        and p.joined_at <= clock_timestamp() and app.message_group_account_available(p.profile_id)),
    'recorded_count', (select count(*) from public.conversation_participants p
      where p.conversation_id = p_conversation_id),
    'has_more', (select count(*) > 50 from public.conversation_participants p
      where p.conversation_id = p_conversation_id)
  );
end;
$$;
revoke execute on function public.message_group_members(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.message_group_members(uuid) to authenticated;

-- Postgres Changes uses the public tables' SELECT RLS. Broadcast/Presence
-- realtime.messages policies are not a replacement and are not widened here.
-- INSERT/UPDATE only in the client: no unfiltered DELETE subscription and no
-- REPLICA IDENTITY FULL copying private old bodies into socket records.
do $publication$
declare v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['messages', 'conversation_participants'] loop
      if not exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$publication$;
