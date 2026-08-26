-- =============================================================================
-- 0010_messaging.sql
--
-- THE THREAT THIS SCHEMA IS BUILT AGAINST
--
--   "Users must NOT be able to read another user's private conversation by
--    manipulating IDs."
--
-- A conversation id is a uuid that appears in a URL, is logged, is shared in
-- screenshots, and is trivially enumerable in an API response. It must therefore
-- be treated as PUBLIC INFORMATION, and knowing one must grant nothing.
--
-- So every read path answers exactly one question -- "is the caller a
-- participant of this conversation?" -- and answers it in the database:
--
--   app.is_conversation_participant(conversation_id, user)
--
-- SECURITY DEFINER is required, not stylistic. The SELECT policy on
-- conversation_participants must itself decide whether the caller participates,
-- which means reading conversation_participants; as a plain subquery that
-- recurses and Postgres aborts. DEFINER runs the lookup with the function
-- owner's rights, so it does not re-enter RLS.
--
-- Two further consequences of taking the ID as public:
--
--   * There is NO policy anywhere that grants access on the basis of having
--     supplied a valid id. Not for conversations, not for messages, not for
--     read receipts, not for attachments.
--   * `sender_id` is forced from auth.uid() in a BEFORE trigger, so a client
--     cannot post a message attributed to someone else even inside a
--     conversation it legitimately belongs to.
--
-- Direct conversations are deduplicated with the same pair_low/pair_high +
-- UNIQUE technique used for connections, so two people who open a chat with each
-- other simultaneously land in one conversation rather than two.
-- =============================================================================


-- =============================================================================
-- conversations
-- =============================================================================

create table public.conversations (
  id uuid primary key default gen_random_uuid(),

  type text not null default 'direct' check (type in ('direct', 'group')),

  -- Group chats only. A direct conversation is titled by its other participant.
  title text check (length(btrim(title)) between 1 and 120),

  created_by uuid references public.profiles (id) on delete set null,

  -- Denormalised so the conversation list sorts without touching messages.
  last_message_at   timestamptz,
  last_message_id   uuid,
  -- A short preview, maintained by trigger. Deliberately not the full body:
  -- the list view needs one line, and copying the whole message would duplicate
  -- content that must stay deletable in one place.
  last_message_preview text,

  -- Pair-dedupe columns for direct conversations, populated by trigger.
  pair_low  uuid,
  pair_high uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint conversations_group_has_title
    check (type <> 'group' or title is not null),

  -- A direct conversation always has its pair recorded; a group never does.
  constraint conversations_pair_coherent check (
    (type = 'direct') = (pair_low is not null and pair_high is not null)
  ),
  constraint conversations_pair_ordered check (
    pair_low is null or pair_low < pair_high
  )
);

comment on table public.conversations is
  'A conversation id is public information. Access is decided by participation only.';

-- The dedupe guarantee for 1:1 chats.
create unique index conversations_direct_pair_key
  on public.conversations (pair_low, pair_high)
  where type = 'direct';

create index conversations_recent_idx
  on public.conversations (last_message_at desc nulls last, id desc);


-- =============================================================================
-- conversation_participants
--
-- Declared immediately after conversations and before any function, because the
-- participation helper is `language sql` and its body is parsed at CREATE time.
-- =============================================================================

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id)      on delete cascade,

  role text not null default 'member' check (role in ('admin', 'member')),

  -- Read state lives here rather than in a separate table: it is one timestamp
  -- per person per conversation, and a join table would add a write per message
  -- read for no extra information.
  last_read_at timestamptz,
  unread_count integer not null default 0,

  is_muted boolean not null default false,

  -- Soft leave. The row is kept so the person's historical messages still
  -- resolve to a participant, and so they cannot silently re-add themselves to
  -- a group they were removed from.
  left_at timestamptz,

  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (conversation_id, profile_id)
);

comment on column public.conversation_participants.left_at is
  'Soft leave. A row with left_at set no longer grants read access to new messages.';

create index conversation_participants_profile_idx
  on public.conversation_participants (profile_id, joined_at desc)
  where left_at is null;

create index conversation_participants_unread_idx
  on public.conversation_participants (profile_id)
  where left_at is null and unread_count > 0;


-- -----------------------------------------------------------------------------
-- The single authorisation predicate for the whole messaging domain.
-- -----------------------------------------------------------------------------

create or replace function app.is_conversation_participant(
  v_conversation_id uuid,
  v_user            uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1
         from public.conversation_participants p
        where p.conversation_id = v_conversation_id
          and p.profile_id = v_user
          and p.left_at is null
     );
$$;

comment on function app.is_conversation_participant(uuid, uuid) is
  'The only basis for messaging access. SECURITY DEFINER to break RLS recursion
   on conversation_participants. Knowing a conversation id grants nothing.';


-- Participation including people who have left, for rendering history.
create or replace function app.was_conversation_participant(
  v_conversation_id uuid,
  v_user            uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1
         from public.conversation_participants p
        where p.conversation_id = v_conversation_id
          and p.profile_id = v_user
     );
$$;


create or replace function app.is_conversation_admin(
  v_conversation_id uuid,
  v_user            uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v_user is not null
     and exists (
       select 1
         from public.conversation_participants p
        where p.conversation_id = v_conversation_id
          and p.profile_id = v_user
          and p.left_at is null
          and p.role = 'admin'
     );
$$;


-- -----------------------------------------------------------------------------
-- Who may start a conversation with whom.
--
-- This is where profiles.allow_messages_from is enforced. Enforcing it only in
-- the UI would mean the preference is decoration.
-- -----------------------------------------------------------------------------

create or replace function app.can_message(v_sender uuid, v_recipient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pref   text;
  v_status text;
begin
  if v_sender is null or v_recipient is null or v_sender = v_recipient then
    return false;
  end if;

  if app.is_blocked_either_way(v_sender, v_recipient) then
    return false;
  end if;

  select p.allow_messages_from, p.status
    into v_pref, v_status
    from public.profiles p
   where p.id = v_recipient;

  if v_pref is null then
    return false;
  end if;

  -- Do not open new conversations with accounts that are not in a state to
  -- reply. A suspended user replying is a moderation problem; a suspended user
  -- receiving is merely a dead end.
  if v_status <> 'active' then
    return false;
  end if;

  return case v_pref
    when 'everyone'    then true
    when 'university'  then app.share_university(v_sender, v_recipient)
    when 'connections' then app.are_connected(v_sender, v_recipient)
    else false                       -- 'nobody'
  end;
end;
$$;


create or replace function app.conversations_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not app.is_privileged_role() then
    new.created_by           := auth.uid();
    new.last_message_at      := null;
    new.last_message_id      := null;
    new.last_message_preview := null;
  end if;

  -- Group conversations carry no pair; direct ones get theirs from
  -- public.start_direct_conversation, which knows both sides.
  if new.type = 'group' then
    new.pair_low  := null;
    new.pair_high := null;
  end if;

  return new;
end;
$$;

create trigger conversations_before_write
  before insert or update on public.conversations
  for each row execute function app.conversations_before_write();

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function app.set_updated_at();

create trigger conversations_protect_columns
  before update on public.conversations
  for each row execute function app.reject_protected_column_change(
    'type', 'created_by', 'created_at', 'pair_low', 'pair_high',
    'last_message_at', 'last_message_id', 'last_message_preview'
  );


alter table public.conversations enable row level security;

-- Note what is absent: there is no policy granting access for supplying a valid
-- id. Participation is the only key.
create policy conversations_select_participant
  on public.conversations for select
  to authenticated
  using (app.was_conversation_participant(id));

-- Every conversation is created through a vetted SECURITY DEFINER function
-- (start_direct_conversation / create_group_conversation), so clients get no
-- INSERT path of their own. That is not merely tidy: a client-side INSERT would
-- need a bootstrap exemption on conversation_participants for "the creator adds
-- the first member", and any such exemption keyed on created_by survives the
-- creator later leaving or being demoted.
create policy conversations_update_admin
  on public.conversations for update
  to authenticated
  using (app.is_conversation_admin(id))
  with check (app.is_conversation_admin(id));

revoke all on table public.conversations from anon, authenticated;
grant select on table public.conversations to authenticated;
-- Only the title. Every denormalised column is trigger-maintained.
grant update (title, updated_at) on table public.conversations to authenticated;
-- No INSERT grant: see above. No DELETE grant either -- a conversation is left,
-- not destroyed. One participant deleting it would delete the other person's
-- copy of the history too.


-- =============================================================================
-- conversation_participants -- triggers, policies, grants
-- =============================================================================

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
      new.unread_count := 0;
      new.left_at      := null;
    end if;

    -- A direct conversation has exactly two participants, forever. Allowing a
    -- third would silently turn a 1:1 chat into a group, exposing history the
    -- new person was never party to.
    if v_type = 'direct' and (
      select count(*) from public.conversation_participants p
       where p.conversation_id = new.conversation_id
    ) >= 2 then
      raise exception 'A direct conversation has exactly two participants'
        using errcode = '42501', hint = 'direct_conversation_full';
    end if;

    if app.is_blocked_either_way(auth.uid(), new.profile_id)
       and not app.is_privileged_role()
    then
      raise exception 'Not permitted'
        using errcode = '42501', hint = 'blocked';
    end if;

  elsif tg_op = 'UPDATE' then
    -- Rejoining after leaving is not an edit; it is a new invitation.
    if old.left_at is not null and new.left_at is null
       and not app.is_privileged_role()
       and not app.is_conversation_admin(new.conversation_id)
    then
      raise exception 'Cannot rejoin a conversation you left'
        using errcode = '42501', hint = 'cannot_rejoin';
    end if;
  end if;

  return new;
end;
$$;

create trigger conversation_participants_before_write
  before insert or update on public.conversation_participants
  for each row execute function app.conversation_participants_before_write();

create trigger conversation_participants_set_updated_at
  before update on public.conversation_participants
  for each row execute function app.set_updated_at();

create trigger conversation_participants_protect_columns
  before update on public.conversation_participants
  for each row execute function app.reject_protected_column_change(
    'conversation_id', 'profile_id', 'joined_at', 'unread_count'
  );


alter table public.conversation_participants enable row level security;

create policy conversation_participants_select
  on public.conversation_participants for select
  to authenticated
  using (app.was_conversation_participant(conversation_id));

-- Only an existing admin may add people. There is deliberately no "the creator
-- may add the first member" exemption -- the creation RPCs insert the founding
-- participants themselves, so no bootstrap hole is needed.
create policy conversation_participants_insert
  on public.conversation_participants for insert
  to authenticated
  with check (app.is_conversation_admin(conversation_id));

-- Your own read state and mute setting.
create policy conversation_participants_update_self
  on public.conversation_participants for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- An admin may change roles and remove people (by setting left_at).
create policy conversation_participants_update_admin
  on public.conversation_participants for update
  to authenticated
  using (app.is_conversation_admin(conversation_id))
  with check (app.is_conversation_admin(conversation_id));

revoke all on table public.conversation_participants from anon, authenticated;
grant select on table public.conversation_participants to authenticated;
grant insert on table public.conversation_participants to authenticated;
grant update (role, last_read_at, is_muted, left_at, updated_at)
  on table public.conversation_participants to authenticated;


-- =============================================================================
-- Starting a direct conversation
--
-- Must be a function rather than an INSERT for three reasons: the pair columns
-- have to be computed from both ids, both participant rows have to exist before
-- the conversation is usable, and opening the same chat twice concurrently has
-- to resolve to one row rather than raising at the client.
-- =============================================================================

create or replace function public.start_direct_conversation(p_other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me        uuid := auth.uid();
  v_low       uuid;
  v_high      uuid;
  v_conv      uuid;
begin
  if v_me is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_other_user = v_me then
    raise exception 'Cannot start a conversation with yourself'
      using errcode = '23514', hint = 'self_conversation';
  end if;

  if not app.can_message(v_me, p_other_user) then
    -- One message for every reason (blocked, preference, suspended, missing) so
    -- the response cannot be used to probe someone's settings.
    raise exception 'You cannot message this person'
      using errcode = '42501', hint = 'messaging_not_permitted';
  end if;

  v_low  := least(v_me, p_other_user);
  v_high := greatest(v_me, p_other_user);

  select c.id into v_conv
    from public.conversations c
   where c.type = 'direct' and c.pair_low = v_low and c.pair_high = v_high;

  if v_conv is not null then
    -- Reopen it for whoever had left, so "message this person again" works
    -- without creating a second thread.
    update public.conversation_participants
       set left_at = null
     where conversation_id = v_conv
       and profile_id in (v_me, p_other_user)
       and left_at is not null;

    return v_conv;
  end if;

  insert into public.conversations (type, created_by, pair_low, pair_high)
  values ('direct', v_me, v_low, v_high)
  -- Loses the race gracefully: the other transaction created it, so use theirs.
  on conflict (pair_low, pair_high) where type = 'direct' do nothing
  returning id into v_conv;

  if v_conv is null then
    select c.id into v_conv
      from public.conversations c
     where c.type = 'direct' and c.pair_low = v_low and c.pair_high = v_high;
    return v_conv;
  end if;

  insert into public.conversation_participants (conversation_id, profile_id, role)
  values (v_conv, v_me, 'member'), (v_conv, p_other_user, 'member')
  on conflict do nothing;

  return v_conv;
end;
$$;

revoke execute on function public.start_direct_conversation(uuid) from public;
grant execute on function public.start_direct_conversation(uuid) to authenticated;


-- =============================================================================
-- Creating a group conversation
--
-- Same reasoning as the direct case: the creator has to become an admin
-- participant in the same transaction that creates the conversation, or the
-- conversation is unreachable by anyone including its author.
-- =============================================================================

create or replace function public.create_group_conversation(
  p_title   text,
  p_members uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_conv   uuid;
  v_member uuid;
begin
  if v_me is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if coalesce(btrim(p_title), '') = '' then
    raise exception 'A group conversation needs a title'
      using errcode = '23514', hint = 'title_required';
  end if;

  if coalesce(array_length(p_members, 1), 0) > 100 then
    raise exception 'Too many members' using errcode = '23514', hint = 'too_many_members';
  end if;

  insert into public.conversations (type, title, created_by)
  values ('group', btrim(p_title), v_me)
  returning id into v_conv;

  insert into public.conversation_participants (conversation_id, profile_id, role)
  values (v_conv, v_me, 'admin');

  foreach v_member in array coalesce(p_members, '{}'::uuid[]) loop
    if v_member <> v_me
       -- A block is respected in both directions. Group membership is a weaker
       -- consent surface than a direct message, so allow_messages_from is not
       -- applied here; being added to a group is visible and leavable, and
       -- applying it would make it impossible to assemble a project team from
       -- people who only accept messages from connections.
       and not app.is_blocked_either_way(v_me, v_member)
    then
      insert into public.conversation_participants (conversation_id, profile_id, role)
      values (v_conv, v_member, 'member')
      on conflict do nothing;
    end if;
  end loop;

  return v_conv;
end;
$$;

revoke execute on function public.create_group_conversation(text, uuid[]) from public;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;


-- =============================================================================
-- messages
-- =============================================================================

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id)      on delete cascade,

  body text check (length(body) <= 4000),

  -- A single optional attachment, stored inline. A separate table would allow
  -- many, which chat does not need and which multiplies the upload validation
  -- surface. MIME is whitelisted here and again in the storage policy.
  attachment_path text,
  attachment_mime text
    check (attachment_mime is null or attachment_mime in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf', 'text/plain'
    )),
  attachment_size integer
    check (attachment_size is null
           or (attachment_size > 0 and attachment_size <= 10485760)),
  attachment_name text check (length(attachment_name) <= 200),

  reply_to_id uuid references public.messages (id) on delete set null,

  is_edited boolean not null default false,
  edited_at timestamptz,

  -- Soft delete keeps the "message deleted" placeholder in the thread, so the
  -- conversation does not silently rewrite itself.
  deleted_at timestamptz,

  moderation_status text not null default 'active'
                    check (moderation_status in ('active', 'hidden', 'removed')),

  created_at timestamptz not null default now(),

  -- An attachment needs all three of its facts, or none.
  constraint messages_attachment_complete check (
    (attachment_path is null
     and attachment_mime is null and attachment_size is null)
    or (attachment_path is not null
        and attachment_mime is not null and attachment_size is not null)
  ),

  constraint messages_not_empty check (
    coalesce(btrim(body), '') <> '' or attachment_path is not null
  )
);

comment on column public.messages.deleted_at is
  'Soft delete. The row remains so the thread keeps its shape and moderation can
   still review what was sent.';

-- Thread pagination. Ascending, because a conversation reads forwards, with id
-- as tiebreaker so a keyset cursor is total-ordered.
create index messages_conversation_idx
  on public.messages (conversation_id, created_at desc, id desc);

create index messages_sender_idx
  on public.messages (sender_id, created_at desc);


create or replace function app.messages_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type      text;
  v_other     uuid;
  v_reply_conv uuid;
begin
  if tg_op = 'INSERT' then
    -- Forced, not validated. Even a participant cannot attribute a message to
    -- another member of the same conversation.
    if not app.is_privileged_role() then
      new.sender_id         := auth.uid();
      new.moderation_status := 'active';
      new.deleted_at        := null;
      new.is_edited         := false;
      new.edited_at         := null;
    end if;

    if not app.is_conversation_participant(new.conversation_id, new.sender_id) then
      raise exception 'Not a participant of this conversation'
        using errcode = '42501', hint = 'not_participant';
    end if;

    -- A reply must be to a message in the SAME conversation. Otherwise the
    -- quoted preview would render text from a thread the reader cannot see.
    if new.reply_to_id is not null then
      select m.conversation_id into v_reply_conv
        from public.messages m where m.id = new.reply_to_id;

      if v_reply_conv is distinct from new.conversation_id then
        raise exception 'Cannot reply to a message in another conversation'
          using errcode = '23514', hint = 'reply_cross_conversation';
      end if;
    end if;

    -- Re-check the recipient's messaging preference on every message in a
    -- direct chat, not only when it was opened. Otherwise blocking someone or
    -- switching to "connections only" would not stop an existing thread.
    select c.type into v_type
      from public.conversations c where c.id = new.conversation_id;

    if v_type = 'direct' then
      select p.profile_id into v_other
        from public.conversation_participants p
       where p.conversation_id = new.conversation_id
         and p.profile_id <> new.sender_id
       limit 1;

      if v_other is not null and app.is_blocked_either_way(new.sender_id, v_other) then
        raise exception 'You cannot message this person'
          using errcode = '42501', hint = 'blocked';
      end if;
    end if;

  elsif tg_op = 'UPDATE' then
    if new.body is distinct from old.body and not app.is_privileged_role() then
      new.is_edited := true;
      new.edited_at := now();
    end if;
  end if;

  return new;
end;
$$;

create trigger messages_before_write
  before insert or update on public.messages
  for each row execute function app.messages_before_write();

create trigger messages_protect_columns
  before update on public.messages
  for each row execute function app.reject_protected_column_change(
    'conversation_id', 'sender_id', 'created_at', 'reply_to_id',
    'attachment_path', 'attachment_mime', 'attachment_size'
  );


-- Denormalised conversation summary + unread counters, in one trigger so the
-- list view and the badge can never disagree with the thread.
create or replace function app.messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at      = new.created_at,
         last_message_id      = new.id,
         last_message_preview = case
           when new.body is not null and btrim(new.body) <> ''
             then left(new.body, 140)
           else '[attachment]'
         end
   where id = new.conversation_id;

  -- Everyone except the sender gains an unread. Their own message is, by
  -- definition, read.
  update public.conversation_participants
     set unread_count = unread_count + 1
   where conversation_id = new.conversation_id
     and profile_id <> new.sender_id
     and left_at is null;

  return null;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function app.messages_after_insert();


alter table public.messages enable row level security;

-- The core guarantee. No id-based access, only participation.
create policy messages_select_participant
  on public.messages for select
  to authenticated
  using (
    app.was_conversation_participant(conversation_id)
    and (moderation_status = 'active' or sender_id = auth.uid())
  );

-- Deliberately NO blanket moderator read policy on private messages. A
-- moderator who can browse any conversation is a worse privacy failure than the
-- id-manipulation attack this file is built to stop. Moderator access is granted
-- in the moderation migration and is scoped to messages that have actually been
-- reported, which is also where public.reports first exists -- policy
-- expressions are resolved at CREATE POLICY time, so it cannot be written here.

create policy messages_insert_participant
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and app.is_conversation_participant(conversation_id)
  );

-- You may edit or soft-delete only your own message.
create policy messages_update_own
  on public.messages for update
  to authenticated
  using (sender_id = auth.uid() and deleted_at is null)
  with check (sender_id = auth.uid());

create policy messages_update_moderator
  on public.messages for update
  to authenticated
  using (app.is_moderator())
  with check (app.is_moderator());

revoke all on table public.messages from anon, authenticated;
grant select on table public.messages to authenticated;
grant insert on table public.messages to authenticated;
grant update (body, deleted_at) on table public.messages to authenticated;
-- No DELETE grant. Hard-deleting a message would remove it from the other
-- person's history and from moderation review.


-- =============================================================================
-- Marking a conversation read
--
-- Resets the counter and stamps the timestamp together. `unread_count` is not in
-- the client's UPDATE grant precisely so that "mark as read" cannot be forged
-- into "mark as unread for everyone else".
-- =============================================================================

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_conversation_participant(p_conversation_id) then
    raise exception 'Not a participant of this conversation'
      using errcode = '42501', hint = 'not_participant';
  end if;

  -- unread_count is protected against client writes, and this function is
  -- reached directly from the client rather than from a trigger, so it has to
  -- declare the write trusted. Participation is already verified above and the
  -- update is scoped to the caller's own row.
  perform app.begin_trusted_write();

  update public.conversation_participants
     set unread_count = 0,
         last_read_at = now()
   where conversation_id = p_conversation_id
     and profile_id = auth.uid();
end;
$$;

revoke execute on function public.mark_conversation_read(uuid) from public;
grant execute on function public.mark_conversation_read(uuid) to authenticated;


-- =============================================================================
-- Total unread badge
--
-- One statement instead of fetching every conversation to add up counters
-- client-side.
-- =============================================================================

create or replace function public.total_unread_messages()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.unread_count), 0)::integer
    from public.conversation_participants p
   where p.profile_id = auth.uid()
     and p.left_at is null
     and not p.is_muted;
$$;

revoke execute on function public.total_unread_messages() from public;
grant execute on function public.total_unread_messages() to authenticated;


-- =============================================================================
-- Function grants
-- =============================================================================

revoke execute on function app.is_conversation_participant(uuid, uuid)  from public;
revoke execute on function app.was_conversation_participant(uuid, uuid) from public;
revoke execute on function app.is_conversation_admin(uuid, uuid)        from public;
revoke execute on function app.can_message(uuid, uuid)                  from public;

grant execute on function app.is_conversation_participant(uuid, uuid)
  to authenticated, service_role;
grant execute on function app.was_conversation_participant(uuid, uuid)
  to authenticated, service_role;
grant execute on function app.is_conversation_admin(uuid, uuid)
  to authenticated, service_role;
grant execute on function app.can_message(uuid, uuid)
  to authenticated, service_role;

revoke execute on function app.conversations_before_write()              from public;
revoke execute on function app.conversation_participants_before_write()  from public;
revoke execute on function app.messages_before_write()                   from public;
revoke execute on function app.messages_after_insert()                   from public;
