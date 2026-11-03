-- 0038 — Bounded account export parity for recipient-bound project invitations.
-- Forward source only. Do not rewrite 0026/0031/0033/0034/0036.
--
-- Sent invitations are bound to the actual inviter, never project management.
-- Received invitations export relationship/outcome state only, excluding the
-- other author's message/proposed_role, participant identities and project
-- title/description. Historical outcomes are own data, not project-page access.
-- The existing profile projection keeps the genuine department_id without
-- joining or exporting the department directory or another profile.
--
-- No reauthentication, session, ownership, worker, RLS or table grant changes.
-- 0007 already cascades project_invites.project_id/inviter_id/invitee_id.
-- 0026 deletes the subject profile in the content phase BEFORE Auth deletion,
-- so invitation rows/notes already disappear there, including after transfer.
-- No extra hosted cleanup helper, retained evidence or UPDATE bypass is needed.

create or replace function app.account_export_page(p_section text, p_after text, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table text; v_predicate text; v_key text := 'r.id::text'; v_fields text[];
  v_rows jsonb; v_records jsonb; v_next text := null;
begin
  if p_limit is null or p_limit not between 1 and 100 or
    (p_after is not null and (length(p_after) > 256 or p_after !~ '^[A-Za-z0-9_:-]+$')) then
    raise exception 'Invalid bounded export options' using errcode = '22023', hint = 'invalid_request';
  end if;
  -- Identifiers, predicates, key expressions and field lists are SERVER-owned.
  -- No auth table, '*' projection, joins to another profile or preview bodies.
  case p_section
    when 'profile' then v_table := 'profiles'; v_predicate := 'r.id = $1'; v_fields := string_to_array('id username display_name avatar_url cover_url headline bio university_id department_id program_id degree semester graduation_year location website github_username linkedin_url twitter_username visibility searchable allow_messages_from allow_connection_requests onboarding_completed created_at', ' ');
    when 'posts' then v_table := 'posts'; v_predicate := 'r.author_id = $1'; v_fields := string_to_array('id body visibility project_id goal_id created_at deleted_at', ' ');
    when 'comments' then v_table := 'comments'; v_predicate := 'r.author_id = $1'; v_fields := string_to_array('id post_id parent_id body created_at deleted_at', ' ');
    when 'messages' then v_table := 'messages'; v_predicate := 'r.sender_id = $1'; v_fields := string_to_array('id conversation_id body attachment_path attachment_mime attachment_size attachment_name created_at deleted_at', ' ');
    when 'projects' then v_table := 'projects'; v_predicate := 'r.owner_id = $1'; v_fields := string_to_array('id slug title tagline description category status visibility cover_url repo_url demo_url is_seeking_members looking_for team_size_target started_at completed_at created_at deleted_at', ' ');
    when 'project_memberships' then v_table := 'project_members'; v_predicate := 'r.profile_id = $1'; v_key := 'r.project_id::text'; v_fields := string_to_array('project_id role title joined_at', ' ');
    when 'project_applications' then v_table := 'project_applications'; v_predicate := 'r.applicant_id = $1'; v_fields := string_to_array('id project_id message desired_role status reviewed_at created_at', ' ');
    when 'project_invites_sent' then v_table := 'project_invites'; v_predicate := 'r.inviter_id = $1'; v_fields := string_to_array('id project_id message proposed_role status responded_at created_at updated_at', ' ');
    when 'project_invites_received' then v_table := 'project_invites'; v_predicate := 'r.invitee_id = $1'; v_fields := string_to_array('id project_id status responded_at created_at updated_at', ' ');
    when 'project_stars' then v_table := 'project_stars'; v_predicate := 'r.profile_id = $1'; v_key := 'r.project_id::text'; v_fields := string_to_array('project_id created_at', ' ');
    when 'ideas' then v_table := 'ideas'; v_predicate := 'r.author_id = $1'; v_fields := string_to_array('id title description category status visibility converted_project_id created_at deleted_at', ' ');
    when 'idea_votes' then v_table := 'idea_votes'; v_predicate := 'r.profile_id = $1'; v_key := 'r.idea_id::text'; v_fields := string_to_array('idea_id created_at', ' ');
    when 'idea_interest' then v_table := 'idea_interest'; v_predicate := 'r.profile_id = $1'; v_key := 'r.idea_id::text'; v_fields := string_to_array('idea_id message offering created_at', ' ');
    when 'connections' then v_table := 'connections'; v_predicate := 'r.requester_id = $1'; v_fields := string_to_array('id addressee_id status message created_at responded_at', ' ');
    when 'follows' then v_table := 'follows'; v_predicate := 'r.follower_id = $1'; v_key := 'r.following_id::text'; v_fields := string_to_array('following_id created_at', ' ');
    when 'blocks' then v_table := 'blocks'; v_predicate := 'r.blocker_id = $1'; v_key := 'r.blocked_id::text'; v_fields := string_to_array('blocked_id reason created_at', ' ');
    when 'profile_skills' then v_table := 'profile_skills'; v_predicate := 'r.profile_id = $1'; v_key := 'r.skill_id::text'; v_fields := string_to_array('skill_id level is_learning display_order created_at', ' ');
    when 'profile_interests' then v_table := 'profile_interests'; v_predicate := 'r.profile_id = $1'; v_key := 'r.interest_id::text'; v_fields := string_to_array('interest_id created_at', ' ');
    when 'endorsements_given' then v_table := 'profile_skill_endorsements'; v_predicate := 'r.endorser_id = $1'; v_key := 'r.profile_id::text || '':'' || r.skill_id::text'; v_fields := string_to_array('profile_id skill_id created_at', ' ');
    when 'achievements' then v_table := 'profile_achievements'; v_predicate := 'r.profile_id = $1'; v_key := 'r.achievement_key'; v_fields := string_to_array('achievement_key awarded_at awarded_value is_pinned', ' ');
    when 'semesters' then v_table := 'semesters'; v_predicate := 'r.profile_id = $1'; v_fields := string_to_array('id name term year start_date end_date is_current created_at', ' ');
    when 'courses' then v_table := 'courses'; v_predicate := 'r.profile_id = $1'; v_fields := string_to_array('id semester_id code title instructor credits status grade created_at', ' ');
    when 'goals' then v_table := 'goals'; v_predicate := 'r.profile_id = $1'; v_fields := string_to_array('id semester_id course_id title description category status target_value current_value unit progress_percent visibility target_date completed_at created_at', ' ');
    when 'goal_milestones' then v_table := 'goal_milestones'; v_predicate := 'exists (select 1 from public.goals g where g.id = r.goal_id and g.profile_id = $1)'; v_fields := string_to_array('id goal_id title is_completed completed_at target_date sort_order', ' ');
    when 'daily_logs' then v_table := 'daily_logs'; v_predicate := 'r.profile_id = $1'; v_fields := string_to_array('id log_date hours_studied mood productivity summary wins blockers created_at updated_at', ' ');
    when 'opportunities' then v_table := 'opportunities'; v_predicate := 'r.posted_by = $1'; v_fields := string_to_array('id title organisation description type work_mode visibility compensation location apply_url apply_email deadline starts_on status created_at deleted_at', ' ');
    when 'opportunity_saves' then v_table := 'opportunity_saves'; v_predicate := 'r.profile_id = $1'; v_key := 'r.opportunity_id::text'; v_fields := string_to_array('opportunity_id created_at', ' ');
    when 'events' then v_table := 'events'; v_predicate := 'r.created_by = $1'; v_fields := string_to_array('id title description location starts_at ends_at timezone capacity visibility status created_at deleted_at', ' ');
    when 'event_attendees' then v_table := 'event_attendees'; v_predicate := 'r.profile_id = $1'; v_key := 'r.event_id::text'; v_fields := string_to_array('event_id status created_at', ' ');
    when 'post_likes' then v_table := 'post_likes'; v_predicate := 'r.profile_id = $1'; v_key := 'r.post_id::text'; v_fields := string_to_array('post_id created_at', ' ');
    when 'post_saves' then v_table := 'post_saves'; v_predicate := 'r.profile_id = $1'; v_key := 'r.post_id::text'; v_fields := string_to_array('post_id created_at', ' ');
    when 'notifications' then v_table := 'notifications'; v_predicate := 'r.recipient_id = $1'; v_fields := string_to_array('id type is_read created_at', ' ');
    when 'reports' then v_table := 'reports'; v_predicate := 'r.reporter_id = $1'; v_fields := string_to_array('id kind reason detail status created_at', ' ');
    when 'bug_reports' then v_table := 'bug_reports'; v_predicate := 'r.reporter_id = $1'; v_fields := string_to_array('id title body page_url status created_at updated_at', ' ');
    when 'university_requests' then v_table := 'universities'; v_predicate := 'r.submitted_by = $1'; v_fields := string_to_array('id name short_name city country website status created_at', ' ');
    else raise exception 'Unknown export section' using errcode = '22023', hint = 'invalid_request';
  end case;
  execute format($query$
    select coalesce(jsonb_agg(jsonb_build_object('key', q.row_key, 'record', q.record) order by q.row_key), '[]'::jsonb)
    from (
      select %s as row_key,
        (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
         from jsonb_each(to_jsonb(r)) e
         where e.key = any($4) and jsonb_typeof(e.value) in ('string', 'number', 'boolean', 'null')) as record
      from public.%I r where (%s) and ($2 is null or (%s) > $2)
      order by %s limit $3
    ) q
  $query$, v_key, v_table, v_predicate, v_key, v_key)
    into v_rows using auth.uid(), p_after, p_limit + 1, v_fields;
  if jsonb_array_length(v_rows) > p_limit then v_next := v_rows->(p_limit - 1)->>'key'; end if;
  select coalesce(jsonb_agg(e.value->'record' order by e.ordinality), '[]'::jsonb) into v_records
    from jsonb_array_elements(v_rows) with ordinality e(value, ordinality) where e.ordinality <= p_limit;
  return jsonb_build_object('records', v_records, 'next_cursor', v_next);
end;
$$;
revoke execute on function app.account_export_page(text, text, integer)
  from public, anon, authenticated, service_role;

create or replace function public.account_export(p_section text default null, p_after text default null, p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sections jsonb := '{}'::jsonb; v_section text; v_result jsonb;
  v_names text[] := array[
    'profile','posts','comments','messages','projects','project_memberships','project_applications',
    'project_invites_sent','project_invites_received',
    'project_stars','ideas','idea_votes','idea_interest','connections','follows','blocks',
    'profile_skills','profile_interests','endorsements_given','achievements','semesters','courses',
    'goals','goal_milestones','daily_logs','opportunities','opportunity_saves','events',
    'event_attendees','post_likes','post_saves','notifications','reports','bug_reports','university_requests'
  ];
begin
  -- Keep the live-session/fresh assurance gate (including the current forward
  -- staff/enrolled-factor rules) and existing fixed export budget authoritative.
  perform app.account_require_reauthentication();
  perform app.account_export_budget();
  if p_section is not null then v_names := array[p_section];
  elsif p_after is not null then raise exception 'Continuation needs a section' using errcode = '22023', hint = 'invalid_request'; end if;
  foreach v_section in array v_names loop
    v_sections := v_sections || jsonb_build_object(v_section, app.account_export_page(v_section, p_after, p_limit));
  end loop;
  v_result := jsonb_build_object('sections', v_sections, 'subject_id', auth.uid());
  if octet_length(v_result::text) > 2097152 then
    raise exception 'Bounded export is too large' using errcode = '54000', hint = 'export_too_large';
  end if;
  return v_result;
end;
$$;
revoke execute on function public.account_export(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export(text, text, integer) to authenticated;
