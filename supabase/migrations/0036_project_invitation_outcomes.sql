-- 0036 — Recipient-bound project invitations and atomic idea outcomes.
-- Forward source only; no hosted write or rewrite of 0007/0009/0025/0026.
-- Existing invite RLS and column grants remain authoritative for mutation RPCs,
-- which are SECURITY INVOKER. A minimal recipient-only inbox intentionally
-- reveals an invited project's title/slug, never its description/member list.
-- Invitations are NOT membership. Every accepted response rechecks current
-- accounts, management, blocks and capacity; raw table writes use the guards too.

create function app.project_invitation_account_available(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_profile is not null
    and exists (select 1 from auth.users u where u.id = p_profile and u.deleted_at is null)
    and exists (select 1 from public.profiles p where p.id = p_profile and p.deleted_at is null)
    and not app.is_account_restricted(p_profile)
    and not app.account_deletion_pending(p_profile);
$$;
revoke execute on function app.project_invitation_account_available(uuid)
  from public, anon, authenticated, service_role;

create function app.project_invitation_available(p_project uuid, p_inviter uuid, p_invitee uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.project_invitation_account_available(p_inviter)
    and app.project_invitation_account_available(p_invitee)
    and app.can_manage_project(p_project, p_inviter)
    and not app.is_blocked_either_way(p_inviter, p_invitee)
    and exists (
      select 1 from public.projects p where p.id = p_project
        and p.deleted_at is null and p.moderation_status = 'active'
        and p.status not in ('completed', 'abandoned')
        and app.project_invitation_account_available(p.owner_id)
        and not app.is_blocked_either_way(p.owner_id, p_invitee)
    );
$$;
revoke execute on function app.project_invitation_available(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function app.project_invitation_acceptance_reason(p_project uuid, p_inviter uuid, p_invitee uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when app.is_project_member(p_project, p_invitee) then 'already_member'
    when not exists (
      select 1 from public.profiles p where p.id = p_invitee and p.allow_connection_requests
    ) or exists (
      select 1 from public.project_members m where m.project_id = p_project
        and app.is_blocked_either_way(m.profile_id, p_invitee)
    ) or app.is_blocked_either_way(p_inviter, p_invitee) then 'unavailable'
    when exists (
      select 1 from public.projects p where p.id = p_project
        and p.team_size_target is not null
        and (select count(*) from public.project_members m where m.project_id = p.id) >= p.team_size_target
    ) then 'full'
    else null
  end;
$$;
revoke execute on function app.project_invitation_acceptance_reason(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Additional restriction, not a new audience. Even a manager cannot read a
-- blocked/stale invitation note through raw REST. Other members get nothing.
create function app.project_invitation_readable(p_project uuid, p_inviter uuid, p_invitee uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.account_lifecycle_access()
    and app.project_invitation_account_available(auth.uid())
    and (p_invitee = auth.uid() or app.can_manage_project(p_project, auth.uid()))
    and not app.is_blocked_either_way(auth.uid(), p_invitee)
    and not app.is_blocked_either_way(auth.uid(), p_inviter)
    and app.project_invitation_available(p_project, p_inviter, p_invitee);
$$;
revoke execute on function app.project_invitation_readable(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function app.project_invitation_readable(uuid, uuid, uuid) to authenticated;

create policy project_invites_current_read on public.project_invites
  as restrictive for select to authenticated
  using (app.project_invitation_readable(project_id, inviter_id, invitee_id));

-- Lock the authoritative project BEFORE checking counts. Every membership
-- insertion route (invite, application, direct manager insert) shares this lock;
-- an invitation-only capacity preflight would race the other routes.
create function app.project_members_current_join_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_project public.projects;
  v_count integer;
begin
  if app.is_privileged_role() and auth.uid() is null then return new; end if;
  select * into v_project from public.projects p where p.id = new.project_id for update;
  if not found or not app.account_lifecycle_access()
     or not app.project_invitation_account_available(auth.uid())
     or not app.project_invitation_account_available(new.profile_id)
     or not app.project_invitation_account_available(v_project.owner_id)
     or v_project.deleted_at is not null or v_project.moderation_status <> 'active'
     or v_project.status in ('completed', 'abandoned') then
    raise exception 'Project membership is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  -- Preserve the automatically created owner and harmless duplicate inserts.
  if new.profile_id = v_project.owner_id or exists (
    select 1 from public.project_members m
      where m.project_id = new.project_id and m.profile_id = new.profile_id
  ) then return new; end if;
  if app.is_blocked_either_way(v_project.owner_id, new.profile_id)
     or app.is_blocked_either_way(coalesce(new.invited_by, auth.uid()), new.profile_id)
     or exists (
       select 1 from public.project_members m where m.project_id = new.project_id
         and app.is_blocked_either_way(m.profile_id, new.profile_id)
     ) then
    raise exception 'Project membership is unavailable' using errcode = '42501', hint = 'blocked';
  end if;
  select count(*) into v_count from public.project_members m where m.project_id = new.project_id;
  if v_project.team_size_target is not null and v_count >= v_project.team_size_target then
    raise exception 'The project has reached its team size' using errcode = '23514', hint = 'project_full';
  end if;
  return new;
end;
$$;
revoke execute on function app.project_members_current_join_guard()
  from public, anon, authenticated, service_role;
create trigger project_members_current_join_guard
  before insert on public.project_members
  for each row execute function app.project_members_current_join_guard();

create or replace function app.project_invites_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_project public.projects;
  v_reason text;
begin
  -- Only actual non-client maintenance may bypass human session checks.
  if app.is_privileged_role() and auth.uid() is null then return new; end if;
  if not app.account_lifecycle_access() or not app.project_invitation_account_available(auth.uid()) then
    raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  select * into v_project from public.projects p where p.id = new.project_id for update;
  if not found then
    raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  if tg_op = 'INSERT' then
    new.inviter_id := auth.uid();
    new.status := 'pending';
    new.responded_at := null;
    if not app.can_manage_project(new.project_id, auth.uid())
       or not app.project_invitation_available(new.project_id, new.inviter_id, new.invitee_id) then
      raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
    end if;
    -- Do not turn the staff profile-read override into unsolicited consent.
    if not exists (
      select 1 from public.profiles recipient
      join public.profiles actor on actor.id = auth.uid()
      where recipient.id = new.invitee_id and recipient.allow_connection_requests
        and (recipient.visibility = 'public'
          or (recipient.visibility = 'university' and recipient.university_id is not null
              and recipient.university_id = actor.university_id)
          or (recipient.visibility = 'connections' and app.are_connected(actor.id, recipient.id)))
    ) then
      raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invites_disabled';
    end if;
    v_reason := app.project_invitation_acceptance_reason(new.project_id, new.inviter_id, new.invitee_id);
    if v_reason = 'already_member' then
      raise exception 'That person is already a member' using errcode = '23514', hint = 'already_member';
    elsif v_reason = 'full' then
      raise exception 'The project has reached its team size' using errcode = '23514', hint = 'project_full';
    elsif v_reason is not null then
      raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'blocked';
    end if;
  else
    if old.status <> 'pending' or new.status not in ('accepted', 'declined', 'revoked') then
      raise exception 'Invitation already answered or invalid response' using errcode = '42501', hint = 'invitation_unavailable';
    end if;
    if new.status = 'revoked' then
      if not app.can_manage_project(old.project_id, auth.uid()) then
        raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
      end if;
    else
      if old.invitee_id <> auth.uid()
         or not app.project_invitation_available(old.project_id, old.inviter_id, old.invitee_id) then
        raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
      end if;
      if new.status = 'accepted' then
        v_reason := app.project_invitation_acceptance_reason(old.project_id, old.inviter_id, old.invitee_id);
        if v_reason = 'already_member' then
          raise exception 'Already a member' using errcode = '23514', hint = 'already_member';
        elsif v_reason = 'full' then
          raise exception 'The project has reached its team size' using errcode = '23514', hint = 'project_full';
        elsif v_reason is not null then
          raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
        end if;
      end if;
    end if;
    -- The server owns response time. A forged future timestamp is not stored.
    new.responded_at := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke execute on function app.project_invites_before_write()
  from public, anon, authenticated, service_role;

-- Reuse 0025's fixed project budget, consumer and ledger. No new configurable
-- bucket, trusted-write exemption or side-effect-only acceptance bypass.
create trigger mandatory_abuse_budget
  after insert or update on public.project_invites
  for each row execute function app.enforce_abuse_budget('project:write');

create function public.project_invitation_inbox(
  p_project_slug text default null, p_limit integer default 31,
  p_before_at timestamptz default null, p_before_id uuid default null
)
returns table (
  invite_id uuid, project_id uuid, project_slug text, project_title text,
  project_visibility text, message text, proposed_role text, created_at timestamptz,
  can_accept boolean, refusal_reason text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.account_lifecycle_access() or not app.project_invitation_account_available(auth.uid()) then
    raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  if p_limit is null or p_limit not between 1 and 31
     or (p_project_slug is not null and (length(p_project_slug) > 128 or p_project_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'))
     or ((p_before_at is null) <> (p_before_id is null)) then
    raise exception 'Invalid invitation page' using errcode = '22023';
  end if;
  return query
    select i.id, p.id, p.slug, p.title, p.visibility, i.message, i.proposed_role, i.created_at,
      reason.value is null, reason.value
    from public.project_invites i
    join public.projects p on p.id = i.project_id
    cross join lateral (
      select app.project_invitation_acceptance_reason(i.project_id, i.inviter_id, i.invitee_id) as value
    ) reason
    where i.invitee_id = auth.uid() and i.status = 'pending'
      and app.project_invitation_available(i.project_id, i.inviter_id, i.invitee_id)
      and (p_project_slug is null or p.slug = p_project_slug)
      and (p_before_at is null or (i.created_at, i.id) < (p_before_at, p_before_id))
    order by i.created_at desc, i.id desc limit p_limit;
end;
$$;
revoke execute on function public.project_invitation_inbox(text, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.project_invitation_inbox(text, integer, timestamptz, uuid) to authenticated;

create function public.respond_to_project_invite(p_invite_id uuid, p_response text)
returns table (project_id uuid, project_slug text, status text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_project uuid;
  v_slug text;
begin
  if not app.account_lifecycle_access() or p_response is null or p_response not in ('accepted', 'declined') then
    raise exception 'Invalid invitation response' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  update public.project_invites i set status = p_response
    where i.id = p_invite_id and i.invitee_id = auth.uid() and i.status = 'pending'
    returning i.project_id into v_project;
  if v_project is null then
    raise exception 'Invitation is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  select p.slug into v_slug from public.projects p where p.id = v_project;
  if p_response = 'accepted' and v_slug is null then
    raise exception 'Membership could not be confirmed' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  -- A declined private project has no readable slug through caller RLS.
  return query select v_project, v_slug, p_response;
end;
$$;
revoke execute on function public.respond_to_project_invite(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.respond_to_project_invite(uuid, text) to authenticated;

-- Preserve the legacy UUID-returning API, its original domain authorization,
-- and 0026's lifecycle gate, but serialize it with the new conversion RPC too.
-- Otherwise a concurrent direct call to the legacy API could overwrite the
-- converted pointer after another caller already created a project.
create or replace function public.convert_idea_to_project(p_idea_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not app.account_lifecycle_access() then
    raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  perform 1 from public.ideas i where i.id = p_idea_id for update;
  return app.account_previous_convert_idea_to_project(p_idea_id);
end;
$$;
revoke execute on function public.convert_idea_to_project(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.convert_idea_to_project(uuid) to authenticated;

create function public.convert_idea_to_project_with_invites(p_idea_id uuid)
returns table (project_id uuid, project_slug text, invited_count integer)
language plpgsql security invoker set search_path = '' as $$
declare
  v_author uuid;
  v_project uuid;
  v_slug text;
  v_invited integer := 0;
  v_person record;
  v_hint text;
begin
  if not app.account_lifecycle_access() then
    raise exception 'Conversion is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  -- The lock makes two simultaneous conversions unable to create two projects.
  -- Caller SELECT/UPDATE policies still apply, and this UI contract is author-only.
  select i.author_id into v_author from public.ideas i
    where i.id = p_idea_id and i.deleted_at is null and i.moderation_status = 'active' for update;
  if v_author is null or v_author <> auth.uid() then
    raise exception 'Only the idea author may convert it' using errcode = '42501', hint = 'not_idea_author';
  end if;
  v_project := public.convert_idea_to_project(p_idea_id);
  select p.slug into v_slug from public.projects p where p.id = v_project;
  if v_slug is null then
    raise exception 'Conversion is unavailable' using errcode = '42501', hint = 'invitation_unavailable';
  end if;
  for v_person in
    select interest.profile_id
      from public.idea_interest interest
      join public.profiles recipient on recipient.id = interest.profile_id
      join public.profiles actor on actor.id = auth.uid()
      where interest.idea_id = p_idea_id and recipient.id <> auth.uid()
        and recipient.allow_connection_requests
        and (recipient.visibility = 'public'
          or (recipient.visibility = 'university' and recipient.university_id is not null
              and recipient.university_id = actor.university_id)
          or (recipient.visibility = 'connections' and app.are_connected(actor.id, recipient.id)))
      order by interest.created_at, interest.profile_id limit 100
  loop
    exit when v_invited >= 29; -- project creation uses one of the fixed 30 slots.
    begin
      -- This INSERT uses 0007's manager RLS and all current/budget guards.
      -- Expected optional refusals roll back this invite AND its notification,
      -- not the valid conversion. Unexpected faults roll back the entire RPC.
      insert into public.project_invites(project_id, invitee_id, message)
        values (v_project, v_person.profile_id, 'You said you would help build this. It is a project now.');
      v_invited := v_invited + 1;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      if sqlstate = 'P0001' and v_hint = 'rate_limit_exceeded' then exit; end if;
      if (sqlstate = '42501' and v_hint in ('blocked', 'invites_disabled', 'invitation_unavailable', 'account_unavailable'))
         or (sqlstate = '23514' and v_hint in ('already_member', 'project_full'))
         or sqlstate in ('23503', '23505') then continue; end if;
      raise;
    end;
  end loop;
  return query select v_project, v_slug, v_invited;
end;
$$;
revoke execute on function public.convert_idea_to_project_with_invites(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.convert_idea_to_project_with_invites(uuid) to authenticated;

-- No project/profile/idea/member table policy or grant was widened. 0007's
-- after-update trigger still creates membership; 0014 still emits bodyless
-- invitation activity. 0026's existing lifecycle guards remain installed.
