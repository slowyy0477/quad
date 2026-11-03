-- =============================================================================
-- 0023 — Participant roles and report target authorization
--
-- Forward-only replacement of the existing guards. Keep the messaging read
-- policies, departed-user history and direct-message preferences unchanged.
-- =============================================================================


-- Own-row UPDATE covers read state, mute and leave, but the shared column grant
-- also includes role for admin operations. RLS is row-level, not column-level:
-- independently authorize an actual role change against the caller's existing
-- admin membership, before writing NEW. The function owner's privileges are not
-- evidence that the caller is privileged.
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
    if new.role is distinct from old.role
       and not app.is_privileged_role()
       and not app.is_conversation_admin(old.conversation_id)
    then
      raise exception 'Only a conversation admin may change participant roles'
        using errcode = '42501', hint = 'participant_role_change_not_permitted';
    end if;

    -- Retain the existing re-invitation guard without changing leave/history.
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

revoke execute on function app.conversation_participants_before_write()
  from public, anon, authenticated;
grant execute on function app.conversation_participants_before_write()
  to service_role;


-- This trigger only normalizes NEW and checks reads; it needs no owner rights.
-- Run as the invoker so eligibility uses the SAME SELECT policies as the
-- reporter's ordinary read, including comment-level rules, existing history
-- access and a moderator's access to messages already legitimately reported.
--
-- Check before INSERT: the new report cannot make its own target readable.
-- Keeping the reads out of the reports INSERT policy also avoids introducing
-- mutual policy expansion through messages_select_reported_moderator.
create or replace function app.reports_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target uuid;
  v_visible boolean;
begin
  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.reporter_id := auth.uid();
      new.status      := 'open';
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;

    if new.user_id is not null and new.user_id = new.reporter_id then
      raise exception 'You cannot report yourself'
        using errcode = '23514', hint = 'self_report';
    end if;

    v_target := case new.kind
      when 'post'    then new.post_id
      when 'comment' then new.comment_id
      when 'project' then new.project_id
      when 'idea'    then new.idea_id
      when 'message' then new.message_id
      when 'profile' then new.user_id
    end;

    -- Leave malformed shapes to the existing one-target/kind CHECKs, preserving
    -- their errors. Valid shapes get one refusal for missing OR unreadable IDs,
    -- before a foreign-key error can disclose that a private target exists.
    if not app.is_privileged_role()
       and v_target is not null
       and pg_catalog.num_nonnulls(
         new.post_id, new.comment_id, new.project_id,
         new.idea_id, new.message_id, new.user_id
       ) = 1
    then
      v_visible := case new.kind
        when 'post' then exists (
          select 1 from public.posts p where p.id = v_target
        )
        when 'comment' then exists (
          select 1 from public.comments c where c.id = v_target
        )
        when 'project' then exists (
          select 1 from public.projects p where p.id = v_target
        )
        when 'idea' then exists (
          select 1 from public.ideas i where i.id = v_target
        )
        when 'message' then exists (
          select 1 from public.messages m where m.id = v_target
        )
        when 'profile' then exists (
          select 1 from public.profiles p where p.id = v_target
        )
        else false
      end;

      if not coalesce(v_visible, false) then
        raise exception 'You can only report something you can see'
          using errcode = '42501', hint = 'report_target_not_visible';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function app.reports_before_write()
  from public, anon, authenticated;
grant execute on function app.reports_before_write()
  to service_role;
