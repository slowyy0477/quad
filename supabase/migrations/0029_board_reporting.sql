-- Forward-only Bulla board safety. No hosted application is implied.
-- Preserve typed targets, caller-RLS eligibility, lifecycle wrappers and audit.

alter table public.reports
  add column event_id uuid references public.events(id) on delete cascade,
  add column opportunity_id uuid references public.opportunities(id) on delete cascade;
alter table public.reports drop constraint reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('post','comment','project','idea','message','profile','event','opportunity'));
alter table public.reports drop constraint reports_one_target;
alter table public.reports add constraint reports_one_target check (
  num_nonnulls(post_id,comment_id,project_id,idea_id,message_id,user_id,event_id,opportunity_id) = 1
);
alter table public.reports drop constraint reports_kind_matches_target;
alter table public.reports add constraint reports_kind_matches_target check (
  (kind = 'post' and post_id is not null) or
  (kind = 'comment' and comment_id is not null) or
  (kind = 'project' and project_id is not null) or
  (kind = 'idea' and idea_id is not null) or
  (kind = 'message' and message_id is not null) or
  (kind = 'profile' and user_id is not null) or
  (kind = 'event' and event_id is not null) or
  (kind = 'opportunity' and opportunity_id is not null)
);
drop index public.reports_one_open_per_reader_target;
create unique index reports_one_open_per_reader_target on public.reports(
  reporter_id,kind,
  coalesce(post_id,comment_id,project_id,idea_id,message_id,user_id,event_id,opportunity_id)
) where status = 'open';
create index reports_event_idx on public.reports(event_id) where event_id is not null;
create index reports_opportunity_idx on public.reports(opportunity_id) where opportunity_id is not null;
grant insert(event_id,opportunity_id) on public.reports to authenticated;

alter table public.moderation_actions
  add column event_id uuid references public.events(id) on delete set null,
  add column opportunity_id uuid references public.opportunities(id) on delete set null;
alter table public.moderation_actions drop constraint moderation_actions_one_content_target;
alter table public.moderation_actions add constraint moderation_actions_one_content_target check (
  num_nonnulls(post_id,comment_id,project_id,idea_id,message_id,event_id,opportunity_id) <= 1
);

-- SECURITY INVOKER is essential: the proposed report cannot make its own
-- target readable through the staff-report exception.
create or replace function app.reports_before_write()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_target uuid; v_visible boolean;
begin
  if tg_op = 'INSERT' then
    if not app.is_privileged_role() then
      new.reporter_id := auth.uid(); new.status := 'open';
      new.reviewed_by := null; new.reviewed_at := null;
    end if;
    if new.user_id is not null and new.user_id = new.reporter_id then
      raise exception 'You cannot report yourself'
        using errcode = '23514', hint = 'self_report';
    end if;
    v_target := case new.kind
      when 'post' then new.post_id when 'comment' then new.comment_id
      when 'project' then new.project_id when 'idea' then new.idea_id
      when 'message' then new.message_id when 'profile' then new.user_id
      when 'event' then new.event_id when 'opportunity' then new.opportunity_id
    end;
    if not app.is_privileged_role() and v_target is not null and
      pg_catalog.num_nonnulls(new.post_id,new.comment_id,new.project_id,new.idea_id,
        new.message_id,new.user_id,new.event_id,new.opportunity_id) = 1 then
      v_visible := case new.kind
        when 'post' then exists(select 1 from public.posts p where p.id = v_target)
        when 'comment' then exists(select 1 from public.comments c where c.id = v_target)
        when 'project' then exists(select 1 from public.projects p where p.id = v_target)
        when 'idea' then exists(select 1 from public.ideas i where i.id = v_target)
        when 'message' then exists(select 1 from public.messages m where m.id = v_target)
        when 'profile' then exists(select 1 from public.profiles p where p.id = v_target)
        when 'event' then exists(select 1 from public.events e where e.id = v_target)
        when 'opportunity' then exists(select 1 from public.opportunities o where o.id = v_target)
        else false end;
      if not coalesce(v_visible,false) then
        raise exception 'You can only report something you can see'
          using errcode = '42501', hint = 'report_target_not_visible';
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.reports_before_write() from public,anon,authenticated;
grant execute on function app.reports_before_write() to service_role;

create or replace function app.reported_profile(r public.reports)
returns uuid language sql stable security definer set search_path = '' as $$
  select case r.kind
    when 'post' then (select p.author_id from public.posts p where p.id = r.post_id)
    when 'comment' then (select c.author_id from public.comments c where c.id = r.comment_id)
    when 'project' then (select p.owner_id from public.projects p where p.id = r.project_id)
    when 'idea' then (select i.author_id from public.ideas i where i.id = r.idea_id)
    when 'message' then (select m.sender_id from public.messages m where m.id = r.message_id)
    when 'profile' then r.user_id
    when 'event' then (select e.created_by from public.events e where e.id = r.event_id)
    when 'opportunity' then (select o.posted_by from public.opportunities o where o.id = r.opportunity_id)
  end;
$$;
revoke execute on function app.reported_profile(public.reports) from public,anon,authenticated;

create or replace function app.reports_record_action()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_action text; v_reason text; v_supersedes uuid;
  v_actor uuid; v_target uuid; v_outcome text;
begin
  if new.status is not distinct from old.status or new.status = 'open' then return null; end if;
  v_action := nullif(pg_catalog.current_setting('app.moderation_action',true),'');
  v_reason := nullif(btrim(coalesce(pg_catalog.current_setting('app.moderation_reason',true),'')),'');
  v_supersedes := nullif(pg_catalog.current_setting('app.moderation_supersedes',true),'')::uuid;
  if v_action is null or v_reason is null then
    raise exception 'A report cannot be closed without a recorded reason'
      using errcode = '42501', hint = 'moderation_reason_required';
  end if;
  v_actor := coalesce(new.reviewed_by,auth.uid());
  v_target := app.reported_profile(new);
  perform app.assert_moderation_allowed(v_actor,v_target);
  insert into public.moderation_actions(
    actor_id,action,reason,report_id,target_profile_id,
    post_id,comment_id,project_id,idea_id,message_id,event_id,opportunity_id,supersedes_id
  ) values (
    v_actor,v_action,v_reason,new.id,v_target,
    new.post_id,new.comment_id,new.project_id,new.idea_id,new.message_id,
    new.event_id,new.opportunity_id,v_supersedes
  );
  v_outcome := case new.status when 'actioned' then 'A moderator acted on your report.'
    when 'dismissed' then 'A moderator reviewed your report and took no action.' end;
  perform app.create_notification(new.reporter_id,'report_reviewed',
    v_body => v_outcome,v_post => new.post_id,v_comment => new.comment_id,
    v_project => new.project_id,v_idea => new.idea_id,
    v_event => new.event_id,v_opportunity => new.opportunity_id);
  return null;
end;
$$;
revoke execute on function app.reports_record_action() from public,anon,authenticated;

-- 0026 moved the original DEFINER body here, behind the public lifecycle
-- access wrapper. Keep that wrapper; extend only the reviewed domain body.
create or replace function app.account_previous_moderate_report(
  p_report_id uuid,p_action text,p_reason text,p_days integer default 7,
  p_supersedes uuid default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_report public.reports;
  v_target uuid; v_mod text; v_status text;
begin
  if v_me is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not app.is_moderator(v_me) then
    raise exception 'You do not have moderator privileges'
      using errcode = '42501',hint = 'not_moderator';
  end if;
  if app.is_account_restricted(v_me) then
    raise exception 'Account is suspended' using errcode = '42501',hint = 'account_suspended';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A bounded reason is required' using errcode = '23514',hint = 'reason_required';
  end if;
  select * into v_report from public.reports where id = p_report_id for update;
  if not found then
    raise exception 'That report does not exist' using errcode = '23503',hint = 'report_not_found';
  end if;
  if v_report.status <> 'open' then
    raise exception 'That report has already been decided' using errcode = '23514',hint = 'report_closed';
  end if;
  v_target := app.reported_profile(v_report);
  perform app.assert_moderation_allowed(v_me,v_target);
  perform app.begin_trusted_write();
  perform app.begin_moderation_action(p_action,p_reason,p_supersedes);
  if p_action in ('hide_content','remove_content','restore_content') then
    v_mod := case p_action when 'hide_content' then 'hidden'
      when 'remove_content' then 'removed' else 'active' end;
    case v_report.kind
      when 'post' then update public.posts set moderation_status = v_mod where id = v_report.post_id;
      when 'comment' then update public.comments set moderation_status = v_mod where id = v_report.comment_id;
      when 'project' then update public.projects set moderation_status = v_mod where id = v_report.project_id;
      when 'idea' then update public.ideas set moderation_status = v_mod where id = v_report.idea_id;
      when 'message' then update public.messages set moderation_status = v_mod where id = v_report.message_id;
      when 'event' then update public.events set moderation_status = v_mod where id = v_report.event_id;
      when 'opportunity' then update public.opportunities set moderation_status = v_mod where id = v_report.opportunity_id;
      else raise exception 'A profile cannot be hidden'
        using errcode = '23514',hint = 'no_content_for_kind';
    end case;
  elsif p_action = 'warn_user' then
    if v_target is null then
      raise exception 'The account is gone' using errcode = '23514',hint = 'no_target';
    end if;
    update public.profiles set warning_count = warning_count + 1 where id = v_target;
  elsif p_action = 'suspend_user' then
    if v_target is null then
      raise exception 'The account is gone' using errcode = '23514',hint = 'no_target';
    end if;
    if p_days is null or p_days not between 1 and 365 then
      raise exception 'Suspension must be 1 to 365 days' using errcode = '23514';
    end if;
    update public.profiles set status = 'suspended',
      suspended_until = now() + make_interval(days => p_days),suspension_reason = btrim(p_reason)
      where id = v_target;
  elsif p_action is distinct from 'dismiss_report' then
    raise exception 'Unknown moderation action' using errcode = '23514',hint = 'unknown_action';
  end if;
  v_status := case when p_action = 'dismiss_report' then 'dismissed' else 'actioned' end;
  update public.reports set status = v_status,reviewed_by = v_me,reviewed_at = now()
    where id = p_report_id;
  return v_status;
end;
$$;
revoke execute on function app.account_previous_moderate_report(uuid,text,text,integer,uuid)
  from public,anon,authenticated,service_role;

-- Closing time is authoritative for direct API answers too. DELETE remains
-- available so an attendee can withdraw their own answer after the start.
create function app.event_answer_cutoff()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_start timestamptz;
begin
  if app.is_privileged_role() then return new; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select starts_at into v_start from public.events where id = new.event_id;
  if not found then
    raise exception 'That event is unavailable' using errcode = '42501',hint = 'event_not_visible';
  end if;
  if v_start <= now() then
    raise exception 'This event has started' using errcode = '42501',hint = 'event_started';
  end if;
  return new;
end;
$$;
revoke execute on function app.event_answer_cutoff() from public,anon,authenticated,service_role;
create trigger bulla_event_answer_cutoff before insert or update on public.event_attendees
  for each row execute function app.event_answer_cutoff();
