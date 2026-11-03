-- =============================================================================
-- 0024 — Message membership windows, safe previews and current DM preferences
--
-- Forward only. No history is deleted. A re-invitation starts a NEW interval;
-- it never makes messages from an absence or before the first join readable.
-- DM preferences apply to every incoming direct send, not to group messages.
-- =============================================================================

create table app.message_membership_history (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null,
  left_at timestamptz not null check (left_at >= joined_at),
  primary key (conversation_id, profile_id, joined_at)
);

alter table app.message_membership_history enable row level security;
revoke all on table app.message_membership_history from public, anon, authenticated;
grant all on table app.message_membership_history to service_role;

-- The old profile index covered only active rows. Retained inbox reads need
-- an indexed owner lookup that includes departed membership rows as well.
create index message_participants_history_profile_idx
  on public.conversation_participants(profile_id, conversation_id);

-- Only the interval still recorded by the old schema can be recovered. Earlier
-- leave/rejoin cycles were not recorded; this migration does not invent them.
insert into app.message_membership_history
  (conversation_id, profile_id, joined_at, left_at)
select conversation_id, profile_id, joined_at, left_at
  from public.conversation_participants
 where left_at is not null;

create or replace function app.message_in_membership(
  v_conversation_id uuid,
  v_created_at timestamptz,
  v_edited_at timestamptz default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and not exists (
       select 1 from public.conversation_participants other
        where other.conversation_id = v_conversation_id
          and app.is_blocked_either_way(auth.uid(), other.profile_id)
     )
     and exists (
       select 1
         from (
           select p.joined_at, p.left_at
             from public.conversation_participants p
            where p.conversation_id = v_conversation_id
              and p.profile_id = auth.uid()
           union all
           select h.joined_at, h.left_at
             from app.message_membership_history h
            where h.conversation_id = v_conversation_id
              and h.profile_id = auth.uid()
         ) membership
        where v_created_at >= membership.joined_at
          and (membership.left_at is null or v_created_at <= membership.left_at)
     )
     -- An edit can contain newly private text. Do not expose an edit made during
     -- an absence through the original message's old, readable creation time.
     and (
       v_edited_at is null or exists (
         select 1
           from (
             select p.joined_at, p.left_at
               from public.conversation_participants p
              where p.conversation_id = v_conversation_id
                and p.profile_id = auth.uid()
             union all
             select h.joined_at, h.left_at
               from app.message_membership_history h
              where h.conversation_id = v_conversation_id
                and h.profile_id = auth.uid()
           ) membership
          where v_edited_at >= membership.joined_at
            and (membership.left_at is null or v_edited_at <= membership.left_at)
       )
     );
$$;

revoke execute on function app.message_in_membership(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function app.message_in_membership(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

create or replace function app.conversation_participants_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select c.type into v_type
    from public.conversations c where c.id = new.conversation_id;

  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.joined_at := clock_timestamp();
      new.unread_count := 0;
      new.left_at := null;
    end if;

    if v_type = 'direct' and (
      select count(*) from public.conversation_participants p
       where p.conversation_id = new.conversation_id
    ) >= 2 then
      raise exception 'A direct conversation has exactly two participants'
        using errcode = '42501', hint = 'direct_conversation_full';
    end if;

    if app.is_blocked_either_way(auth.uid(), new.profile_id)
       and not app.is_privileged_role() then
      raise exception 'Not permitted'
        using errcode = '42501', hint = 'blocked';
    end if;

  elsif tg_op = 'UPDATE' then
    -- Check client-supplied protected values BEFORE normalizing a legitimate
    -- membership transition. Column grants remain unchanged as another guard.
    if not app.is_trusted_write() then
      if new.joined_at is distinct from old.joined_at
         or new.unread_count is distinct from old.unread_count then
        raise exception 'Membership timestamps and unread counters cannot be modified'
          using errcode = '42501', hint = 'protected_participant_columns';
      end if;
    end if;

    -- Preserve 0023's independent role authorization.
    if new.role is distinct from old.role
       and not app.is_privileged_role()
       and not app.is_conversation_admin(old.conversation_id) then
      raise exception 'Only a conversation admin may change participant roles'
        using errcode = '42501', hint = 'participant_role_change_not_permitted';
    end if;

    if old.left_at is not null and new.left_at is null then
      if not app.is_privileged_role()
         and not app.is_conversation_admin(old.conversation_id)
         and not (
           v_type = 'direct'
           and old.profile_id = auth.uid()
           and app.is_marked_trusted_write()
         ) then
        raise exception 'Cannot rejoin a conversation you left'
          using errcode = '42501', hint = 'cannot_rejoin';
      end if;

      if not app.is_privileged_role() or new.joined_at = old.joined_at then
        new.joined_at := greatest(clock_timestamp(), old.left_at);
      end if;
      new.unread_count := 0;
      new.last_read_at := new.joined_at;
    elsif old.left_at is null and new.left_at is not null then
      if not app.is_privileged_role() then
        -- A caller cannot future-date a departure to retain future access.
        new.left_at := clock_timestamp();
      end if;
      new.unread_count := 0;
    elsif old.left_at is not null
          and new.left_at is distinct from old.left_at
          and not app.is_privileged_role() then
      raise exception 'A recorded departure cannot be changed'
        using errcode = '42501', hint = 'departure_immutable';
    end if;
  end if;

  if new.left_at is not null and new.left_at < new.joined_at then
    raise exception 'Departure precedes membership'
      using errcode = '23514', hint = 'invalid_membership_interval';
  end if;
  return new;
end;
$$;

-- joined_at/unread_count are checked above before server-owned normalization.
-- Retain the identity guard and the existing narrow client UPDATE grants.
drop trigger conversation_participants_protect_columns on public.conversation_participants;
create trigger conversation_participants_protect_columns
  before update on public.conversation_participants
  for each row execute function app.reject_protected_column_change(
    'conversation_id', 'profile_id'
  );

create or replace function app.archive_message_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.left_at is not null then
    insert into app.message_membership_history
      (conversation_id, profile_id, joined_at, left_at)
    values (old.conversation_id, old.profile_id, old.joined_at, old.left_at)
    on conflict do nothing;
  end if;
  if new.left_at is not null then
    insert into app.message_membership_history
      (conversation_id, profile_id, joined_at, left_at)
    values (new.conversation_id, new.profile_id, new.joined_at, new.left_at)
    on conflict do nothing;
  end if;
  return null;
end;
$$;

create trigger conversation_participants_archive_membership
  after insert or update on public.conversation_participants
  for each row execute function app.archive_message_membership();

revoke execute on function app.conversation_participants_before_write()
  from public, anon, authenticated;
revoke execute on function app.archive_message_membership()
  from public, anon, authenticated;
grant execute on function app.conversation_participants_before_write(),
  app.archive_message_membership() to service_role;

alter policy messages_select_participant on public.messages
  using (
    app.message_in_membership(conversation_id, created_at, edited_at)
    and (moderation_status = 'active' or sender_id = auth.uid())
  );

-- 0023 reports_before_write is SECURITY INVOKER and reads messages before
-- inserting the report, so it inherits these windows without a definer bypass.
-- The separate, reported-message-only staff read remains intentionally narrow.

create or replace function app.can_read_message_preview(v_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.messages m
     where m.id = v_message_id
       and m.deleted_at is null
       and m.moderation_status = 'active'
       and app.message_in_membership(m.conversation_id, m.created_at, m.edited_at)
  );
$$;

revoke execute on function app.can_read_message_preview(uuid)
  from public, anon, authenticated;
grant execute on function app.can_read_message_preview(uuid) to authenticated, service_role;

-- RLS cannot mask one column of a shared denormalized row. The replacement
-- conversation policy below verifies the complete reader-scoped summary.

-- A former member may read their OWN state, never the remaining members' future
-- unread counters. Active members retain the existing participant-management UI.
alter policy conversation_participants_select on public.conversation_participants
  using (
    profile_id = auth.uid() or app.is_conversation_participant(conversation_id)
  );

create or replace function app.message_conversation_summary(v_conversation_id uuid)
returns table (
  id uuid, type text, title text, created_at timestamptz, updated_at timestamptz,
  last_message_at timestamptz, last_message_preview text, participants jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.type, c.title, c.created_at,
         coalesce(latest.created_at, c.created_at),
         latest.created_at,
         case when latest.body is not null and btrim(latest.body) <> ''
           then left(latest.body, 140)
           when latest.id is not null then '[attachment]'
           else null end,
         (
           select coalesce(jsonb_agg(jsonb_build_object(
             'profile_id', p.profile_id,
             'role', p.role,
             'unread_count', case
               when p.profile_id = auth.uid() and p.left_at is null then (
                 select count(*)::integer from public.messages m
                  where m.conversation_id = c.id
                    and m.sender_id <> auth.uid()
                    and m.deleted_at is null
                    and m.moderation_status = 'active'
                    and (p.last_read_at is null or m.created_at > p.last_read_at)
                    and app.message_in_membership(m.conversation_id, m.created_at, m.edited_at)
               ) else 0 end,
             'is_muted', case when p.profile_id = auth.uid() then p.is_muted else false end,
             'last_read_at', case when p.profile_id = auth.uid() then p.last_read_at else null end,
             'left_at', p.left_at,
             'profile', case when app.can_view_profile(p.profile_id) then (
               select jsonb_build_object(
                 'id', profile.id, 'username', profile.username,
                 'display_name', profile.display_name, 'avatar_url', profile.avatar_url
               ) from public.profiles profile where profile.id = p.profile_id
             ) else null end
           ) order by p.joined_at, p.profile_id), '[]'::jsonb)
             from public.conversation_participants p
            where p.conversation_id = c.id
         )
    from public.conversations c
    join public.conversation_participants mine
      on mine.conversation_id = c.id and mine.profile_id = auth.uid()
    left join lateral (
      select m.id, m.body, m.created_at from public.messages m
       where m.conversation_id = c.id
         and m.deleted_at is null and m.moderation_status = 'active'
         and app.message_in_membership(m.conversation_id, m.created_at, m.edited_at)
       order by m.created_at desc, m.id desc limit 1
    ) latest on true
   where c.id = v_conversation_id
     and not exists (
       select 1 from public.conversation_participants other
        where other.conversation_id = c.id
          and app.is_blocked_either_way(auth.uid(), other.profile_id)
     );
$$;

-- This helper also validates raw denormalized summaries in the SELECT policy
-- below. Its only identity input is auth.uid(); a caller cannot substitute a
-- different reader. The app schema remains unexposed through PostgREST.
revoke execute on function app.message_conversation_summary(uuid)
  from public, anon, authenticated;
grant execute on function app.message_conversation_summary(uuid) to authenticated, service_role;

-- A raw row is safe only when its denormalized values match the reader's current
-- authorized summary. This also suppresses stale previews after edit/moderation.
alter policy conversations_select_participant on public.conversations
  using (
    app.is_conversation_participant(id)
    and (last_message_id is null or app.can_read_message_preview(last_message_id))
    and exists (
      select 1 from app.message_conversation_summary(id) summary
       where summary.last_message_at is not distinct from conversations.last_message_at
         and summary.last_message_preview is not distinct from conversations.last_message_preview
    )
  );

-- No policy now needs the old interval-blind helper. Keep service access, remove
-- the obsolete client grant rather than leaving a redundant definer surface.
revoke execute on function app.was_conversation_participant(uuid, uuid) from authenticated;

create view public.message_conversation_summaries
  with (security_barrier = true, security_invoker = true) as
  select summary.*
    from public.conversation_participants mine
    cross join lateral app.message_conversation_summary(mine.conversation_id) summary
   where mine.profile_id = auth.uid();

revoke all on public.message_conversation_summaries from public, anon, authenticated;
grant select on public.message_conversation_summaries to authenticated, service_role;
comment on view public.message_conversation_summaries is
  'Caller-scoped message inbox: membership-window previews/activity and own unread only. '
  'Security-invoker barrier; the scoped helper derives auth.uid() and never returns raw shared previews.';

-- Use the shared derived account restriction rule. A stale `suspended` status
-- after its expiry is not a permanent DM ban; deleted/permanently restricted
-- accounts still cannot participate in new or existing direct sends.
create or replace function app.can_message(v_sender uuid, v_recipient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pref text;
begin
  if v_sender is null or v_recipient is null or v_sender = v_recipient
     or app.is_blocked_either_way(v_sender, v_recipient) then
    return false;
  end if;
  if app.is_account_restricted(v_sender)
     or not exists (
       select 1 from public.profiles p where p.id = v_sender and p.deleted_at is null
     ) then
    return false;
  end if;
  select p.allow_messages_from into v_pref from public.profiles p
   where p.id = v_recipient and p.deleted_at is null
     and not app.is_account_restricted(v_recipient);
  return case v_pref
    when 'everyone' then true
    when 'university' then app.share_university(v_sender, v_recipient)
    when 'connections' then app.are_connected(v_sender, v_recipient)
    else false
  end;
end;
$$;
-- Keep the pre-existing narrow EXECUTE audience; this replacement adds no grant.

create or replace function public.start_direct_conversation(p_other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_low uuid;
  v_high uuid;
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_other_user = v_me then
    raise exception 'Cannot start a conversation with yourself'
      using errcode = '23514', hint = 'self_conversation';
  end if;
  if not app.can_message(v_me, p_other_user) then
    raise exception 'You cannot message this person'
      using errcode = '42501', hint = 'messaging_not_permitted';
  end if;

  v_low := least(v_me, p_other_user);
  v_high := greatest(v_me, p_other_user);
  insert into public.conversations (type, created_by, pair_low, pair_high)
  values ('direct', v_me, v_low, v_high)
  on conflict (pair_low, pair_high) where type = 'direct' do nothing
  returning id into v_conv;

  if v_conv is null then
    select c.id into v_conv from public.conversations c
     where c.type = 'direct' and c.pair_low = v_low and c.pair_high = v_high;
    -- Opening again is explicit consent from the CALLER only. Do not silently
    -- reopen the other person's membership or reset an active person's reads.
    perform app.begin_trusted_write();
    update public.conversation_participants set left_at = null
     where conversation_id = v_conv and profile_id = v_me and left_at is not null;
  else
    insert into public.conversation_participants (conversation_id, profile_id, role)
    values (v_conv, v_me, 'member'), (v_conv, p_other_user, 'member');
  end if;
  return v_conv;
end;
$$;

revoke execute on function public.start_direct_conversation(uuid) from public, anon, authenticated;
grant execute on function public.start_direct_conversation(uuid) to authenticated, service_role;

-- A retained UUID nonce makes a retry one durable message. Older clients without
-- a nonce still work, but cannot claim retry idempotence.
alter table public.messages add column client_nonce uuid;
create unique index messages_sender_nonce_key on public.messages(sender_id, client_nonce)
  where client_nonce is not null;

create or replace function app.messages_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_other uuid;
  v_reply public.messages;
begin
  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.sender_id := auth.uid();
      new.created_at := clock_timestamp();
      new.moderation_status := 'active';
      new.deleted_at := null;
      new.is_edited := false;
      new.edited_at := null;
    end if;

    if not app.is_conversation_participant(new.conversation_id, new.sender_id) then
      raise exception 'Not a participant of this conversation'
        using errcode = '42501', hint = 'not_participant';
    end if;

    if new.reply_to_id is not null then
      select * into v_reply from public.messages m where m.id = new.reply_to_id;
      if v_reply.conversation_id is distinct from new.conversation_id then
        raise exception 'Cannot reply to a message in another conversation'
          using errcode = '23514', hint = 'reply_cross_conversation';
      end if;
      if not app.is_privileged_role() and (
        v_reply.deleted_at is not null
        or not app.message_in_membership(v_reply.conversation_id, v_reply.created_at, v_reply.edited_at)
        or (v_reply.moderation_status <> 'active' and v_reply.sender_id <> auth.uid())
      ) then
        raise exception 'Cannot reply to a message you cannot read'
          using errcode = '42501', hint = 'reply_not_visible';
      end if;
    end if;

    if exists (
      select 1 from public.conversation_participants p
       where p.conversation_id = new.conversation_id
         and p.left_at is null
         and app.is_blocked_either_way(new.sender_id, p.profile_id)
    ) then
      raise exception 'You cannot message this person'
        using errcode = '42501', hint = 'blocked';
    end if;

    select c.type into v_type from public.conversations c where c.id = new.conversation_id;
    if v_type = 'direct' then
      select p.profile_id into v_other from public.conversation_participants p
       where p.conversation_id = new.conversation_id and p.profile_id <> new.sender_id;
      if v_other is null
         or not app.is_conversation_participant(new.conversation_id, v_other)
         or not app.can_message(new.sender_id, v_other)
         or not exists (
           select 1 from public.profiles p where p.id = v_other and p.deleted_at is null
         ) then
        raise exception 'You cannot message this person'
          using errcode = '42501', hint = 'messaging_not_permitted';
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.body is distinct from old.body and not app.is_privileged_role() then
      new.is_edited := true;
      new.edited_at := clock_timestamp();
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function app.messages_before_write() from public, anon, authenticated;
grant execute on function app.messages_before_write() to service_role;

drop trigger messages_protect_columns on public.messages;
create trigger messages_protect_columns
  before update on public.messages
  for each row execute function app.reject_protected_column_change(
    'conversation_id', 'sender_id', 'created_at', 'reply_to_id',
    'attachment_path', 'attachment_mime', 'attachment_size', 'client_nonce'
  );

create or replace function public.total_unread_messages()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.conversation_participants p
    join public.messages m on m.conversation_id = p.conversation_id
   where p.profile_id = auth.uid() and p.left_at is null and not p.is_muted
     and m.sender_id <> auth.uid()
     and m.deleted_at is null and m.moderation_status = 'active'
     and (p.last_read_at is null or m.created_at > p.last_read_at)
     and app.message_in_membership(m.conversation_id, m.created_at, m.edited_at);
$$;

revoke execute on function public.total_unread_messages() from public, anon, authenticated;
grant execute on function public.total_unread_messages() to authenticated, service_role;
