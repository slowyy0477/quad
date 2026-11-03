-- Bulla S10. Forward source only: never evidence of a hosted migration/worker run.
-- Fresh provider-signed AMR + live Auth session, positive own-data projections,
-- durable deletion intent, JWT replay gates, ownership locks and fenced workers.
-- Storage BYTES are removed through its API, never by SQL metadata deletion.

create table public.account_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately no cascading Auth FK: provider deletion must not lose its job.
  subject_id uuid,
  request_key uuid,
  policy_version text not null default '2026-10-31-v1',
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'retry', 'blocked', 'failed', 'completed')),
  phase text not null default 'media' check (phase in ('media', 'content', 'auth', 'complete')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text check (error_code in (
    'cleanup_failed', 'provider_unavailable', 'media_cleanup_failed',
    'ownership_transfer_required', 'owner_role_inconsistent', 'last_administrator',
    'shared_media_ownership', 'media_ownership_review'
  )),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint account_deletion_lease check (
    (state = 'processing') = (lease_token is not null and lease_expires_at is not null)
  ),
  constraint account_deletion_completion check (
    (state = 'completed') = (completed_at is not null)
    and (state <> 'completed' or
      (subject_id is null and request_key is null and phase = 'complete'))
    and (state = 'completed' or subject_id is not null)
  )
);
create unique index account_deletion_one_job_per_subject
  on public.account_deletion_jobs(subject_id) where subject_id is not null;
create index account_deletion_ready
  on public.account_deletion_jobs(next_attempt_at, created_at)
  where state in ('queued', 'retry', 'processing');

create table public.account_deletion_media (
  id uuid primary key default gen_random_uuid(),
  deletion_job_id uuid not null references public.account_deletion_jobs(id) on delete cascade,
  source_kind text not null check (source_kind in ('private_image', 'owned_storage')),
  source_id uuid,
  object_id uuid,
  bucket_id text not null check (length(bucket_id) between 1 and 100),
  object_path text not null check (length(object_path) between 1 and 1024),
  state text not null default 'pending' check (state in ('pending', 'removed')),
  unique (deletion_job_id, bucket_id, object_path)
);
create index account_deletion_media_pending
  on public.account_deletion_media(deletion_job_id, id) where state = 'pending';

create table public.account_retained_moderation (
  id uuid primary key default gen_random_uuid(),
  deletion_job_id uuid not null references public.account_deletion_jobs(id) on delete cascade,
  category text not null check (category in ('report', 'action')),
  outcome text not null check (outcome in (
    'open', 'actioned', 'dismissed', 'hide_content', 'remove_content',
    'restore_content', 'warn_user', 'suspend_user', 'dismiss_report',
    'approve_university', 'reject_university'
  )),
  occurred_on date not null,
  expires_at timestamptz not null default clock_timestamp() + interval '30 days'
);
comment on table public.account_retained_moderation is
  'Content-free outcomes only: no original report/actor/target/account IDs, names, '
  'reason, body, credential or message. Worker pruning enforces the 30-day policy.';

alter table public.account_deletion_jobs enable row level security;
alter table public.account_deletion_media enable row level security;
alter table public.account_retained_moderation enable row level security;
revoke all on public.account_deletion_jobs, public.account_deletion_media,
  public.account_retained_moderation from public, anon, authenticated, service_role;
create policy account_jobs_no_client_access on public.account_deletion_jobs
  for all to anon, authenticated using (false) with check (false);
create policy account_media_no_client_access on public.account_deletion_media
  for all to anon, authenticated using (false) with check (false);
create policy account_moderation_summary_staff on public.account_retained_moderation
  for select to authenticated using (app.is_moderator());
grant select on public.account_retained_moderation to authenticated;

create table app.account_lifecycle_windows (
  subject_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null check (hits between 1 and 60)
);
revoke all on app.account_lifecycle_windows from public, anon, authenticated, service_role;

create function app.account_deletion_pending(p_subject uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_subject is not null and exists (
    select 1 from public.account_deletion_jobs j
    where j.subject_id = p_subject and j.state <> 'completed'
  );
$$;
revoke execute on function app.account_deletion_pending(uuid) from public, anon, authenticated, service_role;

-- Auth deletion/revocation alone does not invalidate an outstanding JWT. The
-- private data gate survives completion because the Auth user no longer exists.
-- A missing profile may still be repaired for an existing, non-deleting Auth user.
create function app.account_lifecycle_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (select 1 from auth.users u where u.id = auth.uid() and u.deleted_at is null)
    and not app.account_deletion_pending(auth.uid())
    and not exists (
      select 1 from public.profiles p where p.id = auth.uid()
        and (p.deleted_at is not null or p.status = 'deactivated')
    );
$$;
revoke execute on function app.account_lifecycle_access() from public, anon, authenticated, service_role;
grant execute on function app.account_lifecycle_access() to authenticated, service_role;

create function app.account_lifecycle_write_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_privileged_role() and auth.uid() is not null then
    -- Serialize accepted in-flight writes with the request's explicit row lock.
    perform 1 from public.profiles where id = auth.uid() for key share;
    if not app.account_lifecycle_access() then
      raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function app.account_lifecycle_write_guard() from public, anon, authenticated, service_role;

-- Additive RESTRICTIVE gates, not replacements of domain RLS/column grants.
-- Migrations creating later tables MUST also call the installer below; main
-- reviews 0027+ integration. No event trigger or hosted DDL invocation is added.
create function app.install_account_lifecycle_table_guards()
returns void language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  if not app.is_privileged_role() then raise exception 'Server-only lifecycle guard installation' using errcode = '42501'; end if;
  for t in select c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if not exists (select 1 from pg_catalog.pg_policy p
      where p.polrelid = ('public.' || quote_ident(t.relname))::regclass and p.polname = 'account_lifecycle_access_guard') then
      execute format('create policy account_lifecycle_access_guard on public.%I as restrictive for all to authenticated using (app.account_lifecycle_access()) with check (app.account_lifecycle_access())', t.relname);
    end if;
    if t.relname not like 'account\_%' escape '\' and not exists (
      select 1 from pg_catalog.pg_trigger g
      where g.tgrelid = ('public.' || quote_ident(t.relname))::regclass and g.tgname = 'account_lifecycle_write_guard'
    ) then
      execute format('create trigger account_lifecycle_write_guard before insert or update or delete on public.%I for each row execute function app.account_lifecycle_write_guard()', t.relname);
    end if;
  end loop;
end;
$$;
revoke execute on function app.install_account_lifecycle_table_guards() from public, anon, authenticated, service_role;
select app.install_account_lifecycle_table_guards();
create policy account_lifecycle_storage_guard on storage.objects as restrictive
  for all to authenticated using (app.account_lifecycle_access()) with check (app.account_lifecycle_access());

-- Wrap existing client-facing DEFINER RPCs without rewriting their domain
-- bodies or changing signatures/defaults. This closes pre-existing early-return
-- read paths as well as writes from outstanding deleted-account JWTs.
do $wrappers$
declare f record; v_args text; v_body text; v_old text; i integer;
begin
  for f in select p.oid, p.proname, p.pronargs,
      pg_get_function_identity_arguments(p.oid) as identity_args,
      pg_get_function_arguments(p.oid) as declared_args,
      pg_get_function_result(p.oid) as result_type,
      has_function_privilege('authenticated', p.oid, 'execute') as allow_auth,
      has_function_privilege('anon', p.oid, 'execute') as allow_anon,
      has_function_privilege('service_role', p.oid, 'execute') as allow_service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname = any(array[
      'touch_last_active', 'transfer_project_ownership', 'convert_idea_to_project',
      'start_direct_conversation', 'create_group_conversation', 'mark_conversation_read',
      'total_unread_messages', 'current_study_streak', 'unread_notification_count',
      'moderate_report', 'review_university_request', 'check_rate_limit'
    ])
  loop
    v_old := 'account_previous_' || f.proname;
    v_args := '';
    if f.pronargs > 0 then
      for i in 1..f.pronargs loop v_args := v_args || case when i > 1 then ', ' else '' end || '$' || i; end loop;
    end if;
    execute format('alter function public.%I(%s) set schema app', f.proname, f.identity_args);
    execute format('alter function app.%I(%s) rename to %I', f.proname, f.identity_args, v_old);
    execute format('revoke execute on function app.%I(%s) from public, anon, authenticated, service_role', v_old, f.identity_args);
    v_body := case when f.result_type = 'void'
      then format('perform app.%I(%s); return;', v_old, v_args)
      else format('return app.%I(%s);', v_old, v_args) end;
    execute format($ddl$
      create function public.%I(%s) returns %s language plpgsql security definer set search_path = '' as $body$
      begin
        if not app.account_lifecycle_access() then
          raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable';
        end if;
        %s
      end;
      $body$;
    $ddl$, f.proname, f.declared_args, f.result_type, v_body);
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated, service_role', f.proname, f.identity_args);
    if f.allow_auth then execute format('grant execute on function public.%I(%s) to authenticated', f.proname, f.identity_args); end if;
    if f.allow_anon then execute format('grant execute on function public.%I(%s) to anon', f.proname, f.identity_args); end if;
    if f.allow_service then execute format('grant execute on function public.%I(%s) to service_role', f.proname, f.identity_args); end if;
  end loop;
end;
$wrappers$;

create function app.account_require_reauthentication()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_claims jsonb := auth.jwt(); v_method jsonb; v_recent_password boolean := false;
  v_recent_mfa boolean := false; v_timestamp numeric; v_now numeric := extract(epoch from clock_timestamp());
  v_session uuid; v_live boolean;
begin
  if not app.account_lifecycle_access() then
    raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable';
  end if;
  if coalesce(v_claims->>'is_anonymous', 'false') <> 'false'
     or coalesce(v_claims->>'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(v_claims->'amr') is distinct from 'array'
     or to_regclass('auth.sessions') is null then
    raise exception 'Fresh provider verification is required' using errcode = '42501', hint = 'provider_assurance_required';
  end if;
  v_session := (v_claims->>'session_id')::uuid;
  execute 'select exists (select 1 from auth.sessions where id = $1 and user_id = $2)'
    into v_live using v_session, auth.uid();
  if not v_live then raise exception 'Session is no longer available' using errcode = '42501', hint = 'signed_out'; end if;
  for v_method in select value from jsonb_array_elements(v_claims->'amr') loop
    if coalesce(v_method->>'timestamp', '') ~ '^[0-9]{1,12}$' then
      v_timestamp := (v_method->>'timestamp')::numeric;
      if v_timestamp >= v_now - 300 and v_timestamp <= v_now + 30 then
        v_recent_password := v_recent_password or v_method->>'method' = 'password';
        v_recent_mfa := v_recent_mfa or v_method->>'method' in ('totp', 'mfa/totp', 'webauthn', 'mfa/webauthn');
      end if;
    end if;
  end loop;
  v_recent_mfa := v_recent_mfa and coalesce(v_claims->>'aal', '') = 'aal2';
  if (app.is_moderator() and not v_recent_mfa) or (not v_recent_password and not v_recent_mfa) then
    raise exception 'Fresh strong provider verification is required' using errcode = '42501', hint = 'provider_assurance_required';
  end if;
end;
$$;
revoke execute on function app.account_require_reauthentication() from public, anon, authenticated, service_role;

create function app.account_export_budget()
returns void language plpgsql security definer set search_path = '' as $$
declare v_hits integer; v_window timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / 900) * 900);
begin
  insert into app.account_lifecycle_windows(subject_id, window_start, hits)
    values (auth.uid(), v_window, 1)
    on conflict (subject_id) do update
      set window_start = v_window, hits = case when account_lifecycle_windows.window_start = v_window then account_lifecycle_windows.hits + 1 else 1 end
      where account_lifecycle_windows.window_start <> v_window or account_lifecycle_windows.hits < 60
    returning hits into v_hits;
  if v_hits is null then raise exception 'Too many export requests' using errcode = 'P0001', hint = 'throttled'; end if;
end;
$$;
revoke execute on function app.account_export_budget() from public, anon, authenticated, service_role;

create function app.account_export_page(p_section text, p_after text, p_limit integer)
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
revoke execute on function app.account_export_page(text, text, integer) from public, anon, authenticated, service_role;

create function public.account_export(p_section text default null, p_after text default null, p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sections jsonb := '{}'::jsonb; v_section text; v_result jsonb;
  v_names text[] := array[
    'profile','posts','comments','messages','projects','project_memberships','project_applications',
    'project_stars','ideas','idea_votes','idea_interest','connections','follows','blocks',
    'profile_skills','profile_interests','endorsements_given','achievements','semesters','courses',
    'goals','goal_milestones','daily_logs','opportunities','opportunity_saves','events',
    'event_attendees','post_likes','post_saves','notifications','reports','bug_reports','university_requests'
  ];
begin
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
revoke execute on function public.account_export(text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.account_export(text, text, integer) to authenticated;

create function app.account_lock_private_images()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if to_regclass('app.private_image_budgets') is not null then
    execute 'select 1 from app.private_image_budgets where subject = ''global'' for update';
  end if;
end;
$$;
revoke execute on function app.account_lock_private_images() from public, anon, authenticated, service_role;

create function app.account_deletion_blockers(p_subject uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_projects jsonb; v_count integer; v_roles boolean; v_last_admin boolean;
  v_media boolean := false; v_private_media boolean := false; v_pending_images boolean := false; v_buckets boolean;
begin
  select count(*)::integer into v_count from public.projects p where p.owner_id = p_subject
    and exists (select 1 from public.project_members m where m.project_id = p.id and m.profile_id <> p_subject);
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'slug', q.slug, 'title', q.title, 'deleted', q.deleted_at is not null)), '[]'::jsonb)
    into v_projects from (
      select p.id, p.slug, p.title, p.deleted_at from public.projects p where p.owner_id = p_subject
        and exists (select 1 from public.project_members m where m.project_id = p.id and m.profile_id <> p_subject)
      order by p.id limit 50
    ) q;
  select exists (
    select 1 from public.projects p where p.owner_id = p_subject
      and not exists (select 1 from public.project_members m where m.project_id = p.id and m.profile_id = p_subject and m.role = 'owner')
  ) or exists (
    select 1 from public.project_members m where m.profile_id = p_subject and m.role = 'owner'
      and not exists (select 1 from public.projects p where p.id = m.project_id and p.owner_id = p_subject)
  ) into v_roles;
  select exists (select 1 from public.user_roles r where r.user_id = p_subject and r.role = 'admin')
    and not exists (
      select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
      where r.role = 'admin' and r.user_id <> p_subject and p.deleted_at is null
        and (p.status = 'active' or (p.status = 'suspended' and p.suspended_until <= clock_timestamp()))
        and not app.account_deletion_pending(r.user_id)
    ) into v_last_admin;
  -- Typed references protect media attached to surviving content, not just its uploader.
  select exists (
    select 1 from storage.objects o
    where coalesce(to_jsonb(o)->>'owner_id', to_jsonb(o)->>'owner') = p_subject::text
      and (
        exists (select 1 from public.project_media m join public.projects p on p.id = m.project_id
          where p.owner_id <> p_subject and m.storage_path in (o.name, o.bucket_id || '/' || o.name))
        or exists (select 1 from public.post_media m join public.posts p on p.id = m.post_id
          where p.author_id <> p_subject and m.storage_path in (o.name, o.bucket_id || '/' || o.name))
        or exists (select 1 from public.messages m where m.sender_id <> p_subject
          and m.attachment_path in (o.name, o.bucket_id || '/' || o.name))
        or exists (select 1 from public.projects p where p.owner_id <> p_subject
          and right(coalesce(p.cover_url, ''), length(o.name) + 1) = '/' || o.name)
        or exists (select 1 from public.profiles p where p.id <> p_subject
          and (right(coalesce(p.avatar_url, ''), length(o.name) + 1) = '/' || o.name
            or right(coalesce(p.cover_url, ''), length(o.name) + 1) = '/' || o.name))
      )
  ) into v_media;
  if to_regclass('public.private_images') is not null then
    execute $images$
      select exists (
        select 1 from public.private_images i
        where (i.actor_id = $1 and i.owner_id <> $1) or
          (i.owner_id = $1 and i.project_id is not null and
            not exists (select 1 from public.projects p where p.id = i.project_id and p.owner_id = $1))
      )
    $images$ into v_private_media using p_subject;
    execute 'select exists (select 1 from public.private_images where (owner_id = $1 or actor_id = $1) and state = ''pending'' and expires_at > clock_timestamp() - interval ''30 seconds'')'
      into v_pending_images using p_subject;
  end if;
  select exists (select 1 from storage.buckets b
    where coalesce(to_jsonb(b)->>'owner_id', to_jsonb(b)->>'owner') = p_subject::text) into v_buckets;
  return jsonb_build_object(
    'projects', v_projects, 'moreProjects', v_count > 50,
    'inconsistentOwnerRole', v_roles, 'lastAdministrator', v_last_admin,
    'sharedMedia', v_media or v_private_media or v_pending_images, 'ownedStorageBucket', v_buckets
  );
end;
$$;
revoke execute on function app.account_deletion_blockers(uuid) from public, anon, authenticated, service_role;

create function public.account_lifecycle_preflight()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not app.account_lifecycle_access() then raise exception 'Account is unavailable' using errcode = '42501', hint = 'account_unavailable'; end if;
  return app.account_deletion_blockers(auth.uid());
end;
$$;
revoke execute on function public.account_lifecycle_preflight() from public, anon, authenticated, service_role;
grant execute on function public.account_lifecycle_preflight() to authenticated;

create function app.account_blocker_code(p_blockers jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when jsonb_array_length(p_blockers->'projects') > 0 or (p_blockers->>'moreProjects')::boolean then 'ownership_transfer_required'
    when (p_blockers->>'inconsistentOwnerRole')::boolean then 'owner_role_inconsistent'
    when (p_blockers->>'lastAdministrator')::boolean then 'last_administrator'
    when (p_blockers->>'sharedMedia')::boolean or (p_blockers->>'ownedStorageBucket')::boolean then 'shared_media_ownership'
  end;
$$;
revoke execute on function app.account_blocker_code(jsonb) from public, anon, authenticated, service_role;

create function public.account_request_deletion(p_confirmation text, p_acknowledge boolean, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_subject uuid := auth.uid(); v_job public.account_deletion_jobs; v_block text;
begin
  perform app.account_require_reauthentication();
  if p_confirmation is distinct from 'DELETE MY ACCOUNT' or p_acknowledge is distinct from true or p_request_key is null then
    raise exception 'Explicit deletion confirmation is required' using errcode = '22023', hint = 'confirmation_required';
  end if;
  perform app.account_lock_private_images();
  perform 1 from public.user_roles where role = 'admin' order by user_id for update;
  perform 1 from public.profiles where id = v_subject for update;
  perform 1 from public.projects where owner_id = v_subject order by id for update;
  -- Locks precede the final availability/ownership check; no stale preflight grant.
  perform app.account_require_reauthentication();
  v_block := app.account_blocker_code(app.account_deletion_blockers(v_subject));
  if v_block is not null then raise exception 'Account ownership must be resolved' using errcode = '42501', hint = v_block; end if;
  if to_regclass('auth.refresh_tokens') is null then
    raise exception 'Auth revocation is unavailable' using errcode = '55000', hint = 'unavailable';
  end if;
  perform app.begin_trusted_write();
  update public.profiles set status = 'deactivated', searchable = false, allow_messages_from = 'nobody',
    allow_connection_requests = false where id = v_subject;
  insert into public.account_deletion_jobs(subject_id, request_key)
    values (v_subject, p_request_key) returning * into v_job;
  -- Actual hosted platform tables. Test-only shims are in the new test file,
  -- NOT migrations/bootstrap; this cannot silently succeed without revocation.
  execute 'delete from auth.refresh_tokens where user_id::text = $1' using v_subject::text;
  execute 'delete from auth.sessions where user_id = $1' using v_subject;
  return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'phase', v_job.phase);
end;
$$;
revoke execute on function public.account_request_deletion(text, boolean, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_request_deletion(text, boolean, uuid) to authenticated;

-- Random status-only receipts are not profile/content credentials. No identity,
-- timestamps, lease, retained evidence or exception detail is returned.
create function public.account_deletion_status(p_receipt uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', j.id, 'state', j.state, 'phase', j.phase)
  from public.account_deletion_jobs j where j.id = p_receipt
    and (j.completed_at is null or j.completed_at > clock_timestamp() - interval '30 days');
$$;
revoke execute on function public.account_deletion_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_status(uuid) to anon, authenticated, service_role;

-- Ownership cannot be newly assigned to a queued/deleted account, including
-- writes made inside the existing transfer RPC. New membership serializes on
-- its parent project so the deletion request cannot miss a just-accepted member.
create function app.account_project_owner_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.owner_id = old.owner_id then return new; end if;
  perform 1 from public.profiles p where p.id = new.owner_id for key share;
  if app.account_deletion_pending(new.owner_id) or not exists (
    select 1 from public.profiles p where p.id = new.owner_id and p.deleted_at is null
      and (p.status = 'active' or (p.status = 'suspended' and p.suspended_until <= clock_timestamp()))
  ) then
    raise exception 'New owner is unavailable' using errcode = '42501', hint = 'ownership_transfer_required';
  end if;
  return new;
end;
$$;
revoke execute on function app.account_project_owner_guard() from public, anon, authenticated, service_role;
create trigger zz_account_project_owner_guard before insert or update of owner_id on public.projects
  for each row execute function app.account_project_owner_guard();

create function app.account_project_membership_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select owner_id into v_owner from public.projects where id = new.project_id for update;
  if app.account_deletion_pending(v_owner) or app.account_deletion_pending(new.profile_id) then
    raise exception 'Project ownership is awaiting deletion' using errcode = '42501', hint = 'ownership_transfer_required';
  end if;
  return new;
end;
$$;
revoke execute on function app.account_project_membership_guard() from public, anon, authenticated, service_role;
create trigger account_project_membership_guard before insert or update of project_id, profile_id on public.project_members
  for each row execute function app.account_project_membership_guard();

-- A provider/admin hard delete also cannot silently cascade shared projects.
create function app.account_profile_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_block text;
begin
  perform app.account_lock_private_images();
  perform 1 from public.user_roles where role = 'admin' order by user_id for update;
  perform 1 from public.projects where owner_id = old.id order by id for update;
  v_block := app.account_blocker_code(app.account_deletion_blockers(old.id));
  if v_block is not null then raise exception 'Account ownership must be resolved before hard deletion' using errcode = '42501', hint = v_block; end if;
  return old;
end;
$$;
revoke execute on function app.account_profile_delete_guard() from public, anon, authenticated, service_role;
create trigger account_profile_delete_guard before delete on public.profiles
  for each row execute function app.account_profile_delete_guard();

-- No public cleanup HTTP endpoint. Only the explicitly enabled SERVER worker
-- receives a service-role client. Every privileged call also checks its caller.
create function app.account_worker_only()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_privileged_role() then
    raise exception 'Account cleanup is server-only' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function app.account_worker_only() from public, anon, authenticated, service_role;

create function app.account_deletion_fence(p_job uuid, p_lease uuid)
returns public.account_deletion_jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs;
begin
  perform app.account_worker_only();
  select * into v_job from public.account_deletion_jobs where id = p_job for update;
  if v_job.id is null or v_job.state <> 'processing' or p_lease is null or
     v_job.lease_token is distinct from p_lease or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'Stale account cleanup lease' using errcode = '42501', hint = 'stale_cleanup_lease';
  end if;
  return v_job;
end;
$$;
revoke execute on function app.account_deletion_fence(uuid, uuid) from public, anon, authenticated, service_role;

create function public.account_deletion_claim(p_job uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs;
begin
  perform app.account_worker_only();
  -- Deterministic bounded pruning. Invocation/deployment is an operator gate.
  delete from public.account_retained_moderation where id in (
    select id from public.account_retained_moderation where expires_at <= clock_timestamp() order by expires_at limit 250
  );
  delete from public.account_deletion_jobs where id in (
    select id from public.account_deletion_jobs where state = 'completed'
      and completed_at <= clock_timestamp() - interval '30 days' order by completed_at limit 250
  );
  delete from app.account_lifecycle_windows where window_start < clock_timestamp() - interval '1 day';
  update public.account_deletion_jobs set state = 'failed', error_code = 'cleanup_failed',
    lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
    where attempts >= 5 and state in ('queued', 'retry', 'processing')
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp());
  select * into v_job from public.account_deletion_jobs
    where (p_job is null or id = p_job) and attempts < 5 and (
      (state in ('queued', 'retry') and next_attempt_at <= clock_timestamp()) or
      (state = 'processing' and lease_expires_at <= clock_timestamp())
    )
    order by next_attempt_at, created_at for update skip locked limit 1;
  if v_job.id is null then return null; end if;
  update public.account_deletion_jobs set state = 'processing', attempts = attempts + 1,
    lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '10 minutes',
    error_code = null, updated_at = clock_timestamp()
    where id = v_job.id returning * into v_job;
  return jsonb_build_object('id', v_job.id, 'subject_id', v_job.subject_id,
    'phase', v_job.phase, 'lease_token', v_job.lease_token);
end;
$$;
revoke execute on function public.account_deletion_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_claim(uuid) to service_role;

create function public.account_deletion_prepare_media(p_job uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs; v_block text; v_pending integer;
begin
  perform app.account_worker_only();
  perform app.account_lock_private_images();
  v_job := app.account_deletion_fence(p_job, p_lease);
  perform 1 from public.user_roles where role = 'admin' order by user_id for update;
  perform 1 from public.profiles where id = v_job.subject_id for update;
  perform 1 from public.projects where owner_id = v_job.subject_id order by id for update;
  v_block := app.account_blocker_code(app.account_deletion_blockers(v_job.subject_id));
  if v_block is not null then
    update public.account_deletion_jobs set state = 'blocked', error_code = v_block,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp() where id = p_job;
    return jsonb_build_object('ready', false, 'code', v_block);
  end if;
  -- 0027's immutable private-image association is authoritative even for
  -- normalized service-uploaded objects whose Storage owner_id is NULL.
  if to_regclass('public.private_images') is not null then
    execute $inventory$
      insert into public.account_deletion_media(deletion_job_id, source_kind, source_id, object_id, bucket_id, object_path)
      select $1, 'private_image', i.id, o.id, 'bulla-private-images', i.id::text || '.webp'
      from public.private_images i left join storage.objects o
        on o.bucket_id = 'bulla-private-images' and o.name = i.id::text || '.webp'
      where i.owner_id = $2
      on conflict (deletion_job_id, bucket_id, object_path) do nothing
    $inventory$ using p_job, v_job.subject_id;
    execute 'update public.private_images set state = ''retired'' where owner_id = $1 and state in (''pending'', ''ready'')'
      using v_job.subject_id;
  end if;
  insert into public.account_deletion_media(deletion_job_id, source_kind, object_id, bucket_id, object_path)
    select p_job, 'owned_storage', o.id, o.bucket_id, o.name
    from storage.objects o
    where coalesce(to_jsonb(o)->>'owner_id', to_jsonb(o)->>'owner') = v_job.subject_id::text
      or split_part(o.name, '/', 1) = v_job.subject_id::text
    on conflict (deletion_job_id, bucket_id, object_path) do nothing;
  -- A prior API delete followed by a crash/reappearing exact object remains
  -- fenced by the original manifest. Never enumerate unrelated object paths.
  update public.account_deletion_media m set state = 'pending', object_id = o.id
    from storage.objects o where m.deletion_job_id = p_job and m.state = 'removed'
      and o.bucket_id = m.bucket_id and o.name = m.object_path;
  select count(*)::integer into v_pending from public.account_deletion_media
    where deletion_job_id = p_job and state = 'pending';
  update public.account_deletion_jobs set phase = case when v_pending = 0 then 'content' else 'media' end,
    updated_at = clock_timestamp() where id = p_job;
  return jsonb_build_object('ready', true, 'pending', v_pending);
end;
$$;
revoke execute on function public.account_deletion_prepare_media(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_prepare_media(uuid, uuid) to service_role;

create function public.account_deletion_media_batch(p_job uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs; m record; v_object storage.objects; v_image_ok boolean;
  v_result jsonb := '[]'::jsonb;
begin
  perform app.account_worker_only();
  perform app.account_lock_private_images();
  v_job := app.account_deletion_fence(p_job, p_lease);
  for m in select * from public.account_deletion_media where deletion_job_id = p_job and state = 'pending'
    order by id limit 50
  loop
    select * into v_object from storage.objects where bucket_id = m.bucket_id and name = m.object_path;
    if v_object.id is not null and m.object_id is not null and v_object.id <> m.object_id then
      raise exception 'Object was replaced after inventory' using errcode = '42501', hint = 'media_ownership_review';
    end if;
    if m.source_kind = 'owned_storage' then
      if split_part(m.object_path, '/', 1) <> v_job.subject_id::text
        or (v_object.id is not null and coalesce(to_jsonb(v_object)->>'owner_id', to_jsonb(v_object)->>'owner') is distinct from v_job.subject_id::text) then
        raise exception 'Storage ownership/namespace needs review' using errcode = '42501', hint = 'media_ownership_review';
      end if;
    else
      if m.source_id is null or m.bucket_id <> 'bulla-private-images' or m.object_path <> m.source_id::text || '.webp' then
        raise exception 'Invalid private image manifest' using errcode = '42501', hint = 'media_ownership_review';
      end if;
      v_image_ok := true;
      if to_regclass('public.private_images') is not null then
        -- A missing already-forgotten row is recoverable ONLY via the durable
        -- original manifest; a newly owned/reused row is not.
        execute 'select not exists (select 1 from public.private_images where id = $1 and (owner_id <> $2 or state <> ''retired''))'
          into v_image_ok using m.source_id, v_job.subject_id;
      end if;
      if not v_image_ok or (v_object.id is not null and
        coalesce(to_jsonb(v_object)->>'owner_id', to_jsonb(v_object)->>'owner') is not null and
        coalesce(to_jsonb(v_object)->>'owner_id', to_jsonb(v_object)->>'owner') <> v_job.subject_id::text) then
        raise exception 'Private image ownership changed' using errcode = '42501', hint = 'media_ownership_review';
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', m.id, 'source_kind', m.source_kind, 'source_id', m.source_id,
      'bucket_id', m.bucket_id, 'object_path', m.object_path
    ));
  end loop;
  return v_result;
end;
$$;
revoke execute on function public.account_deletion_media_batch(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_media_batch(uuid, uuid) to service_role;

create function public.account_deletion_mark_media_removed(p_job uuid, p_lease uuid, p_media uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs; v_media public.account_deletion_media;
begin
  perform app.account_worker_only();
  perform app.account_lock_private_images();
  v_job := app.account_deletion_fence(p_job, p_lease);
  select * into v_media from public.account_deletion_media where id = p_media and deletion_job_id = p_job for update;
  if v_media.id is null then raise exception 'Unknown cleanup manifest' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects where bucket_id = v_media.bucket_id and name = v_media.object_path) then
    raise exception 'Storage API removal has not completed' using errcode = '55000', hint = 'media_cleanup_failed';
  end if;
  if v_media.source_kind = 'private_image' and to_regclass('public.private_images') is not null then
    execute 'delete from public.private_images where id = $1 and owner_id = $2 and state = ''retired'''
      using v_media.source_id, v_job.subject_id;
    if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relname = 'private_image_budgets') then
      execute 'delete from app.private_image_budgets where subject = $1' using v_job.subject_id::text;
    end if;
  end if;
  update public.account_deletion_media set state = 'removed' where id = p_media;
  if not exists (select 1 from public.account_deletion_media where deletion_job_id = p_job and state = 'pending') then
    update public.account_deletion_jobs set phase = 'content', updated_at = clock_timestamp() where id = p_job;
  end if;
end;
$$;
revoke execute on function public.account_deletion_mark_media_removed(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_mark_media_removed(uuid, uuid, uuid) to service_role;

create function public.account_deletion_cleanup_content(p_job uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs; v_block text; v_reports uuid[]; v_actions uuid[];
begin
  perform app.account_worker_only();
  perform app.account_lock_private_images();
  v_job := app.account_deletion_fence(p_job, p_lease);
  if v_job.phase = 'auth' then return jsonb_build_object('ready', true); end if;
  if v_job.phase <> 'content' or exists (
    select 1 from public.account_deletion_media where deletion_job_id = p_job and state <> 'removed'
  ) then raise exception 'Media cleanup is not complete' using errcode = '55000', hint = 'media_cleanup_failed'; end if;
  perform 1 from public.user_roles where role = 'admin' order by user_id for update;
  perform 1 from public.profiles where id = v_job.subject_id for update;
  perform 1 from public.projects where owner_id = v_job.subject_id order by id for update;
  v_block := app.account_blocker_code(app.account_deletion_blockers(v_job.subject_id));
  if v_block is not null then
    update public.account_deletion_jobs set state = 'blocked', error_code = v_block,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp() where id = p_job;
    return jsonb_build_object('ready', false, 'code', v_block);
  end if;
  select coalesce(array_agg(r.id), array[]::uuid[]) into v_reports from public.reports r
    where r.reporter_id = v_job.subject_id or r.user_id = v_job.subject_id
      or r.post_id in (select id from public.posts where author_id = v_job.subject_id)
      or r.comment_id in (select c.id from public.comments c join public.posts p on p.id = c.post_id
        where c.author_id = v_job.subject_id or p.author_id = v_job.subject_id)
      or r.project_id in (select id from public.projects where owner_id = v_job.subject_id)
      or r.idea_id in (select id from public.ideas where author_id = v_job.subject_id)
      or r.message_id in (select id from public.messages where sender_id = v_job.subject_id)
      -- 0029 adds typed board targets. JSON projection also works before those
      -- columns exist, without making this earlier migration depend on 0029.
      or to_jsonb(r)->>'event_id' in (select id::text from public.events where created_by = v_job.subject_id)
      or to_jsonb(r)->>'opportunity_id' in (select id::text from public.opportunities where posted_by = v_job.subject_id);
  select coalesce(array_agg(a.id), array[]::uuid[]) into v_actions from public.moderation_actions a
    where a.actor_id = v_job.subject_id or a.target_profile_id = v_job.subject_id or a.report_id = any(v_reports)
      or a.post_id in (select id from public.posts where author_id = v_job.subject_id)
      or a.comment_id in (select c.id from public.comments c join public.posts p on p.id = c.post_id
        where c.author_id = v_job.subject_id or p.author_id = v_job.subject_id)
      or a.project_id in (select id from public.projects where owner_id = v_job.subject_id)
      or a.idea_id in (select id from public.ideas where author_id = v_job.subject_id)
      or a.message_id in (select id from public.messages where sender_id = v_job.subject_id)
      or to_jsonb(a)->>'event_id' in (select id::text from public.events where created_by = v_job.subject_id)
      or to_jsonb(a)->>'opportunity_id' in (select id::text from public.opportunities where posted_by = v_job.subject_id);
  insert into public.account_retained_moderation(deletion_job_id, category, outcome, occurred_on)
    select p_job, 'report', r.status, (r.created_at at time zone 'UTC')::date from public.reports r where r.id = any(v_reports);
  insert into public.account_retained_moderation(deletion_job_id, category, outcome, occurred_on)
    select p_job, 'action', a.action, (a.created_at at time zone 'UTC')::date from public.moderation_actions a where a.id = any(v_actions);
  -- Exception to append-only is narrow, service-only and replaces free text
  -- with the minimal retained summaries above in this SAME transaction.
  delete from public.moderation_actions where id = any(v_actions);
  delete from public.reports where id = any(v_reports);
  update public.comments set parent_id = null
    where author_id <> v_job.subject_id and parent_id in (
      select id from public.comments where author_id = v_job.subject_id
    ) and post_id not in (select id from public.posts where author_id = v_job.subject_id);
  update public.conversations c set last_message_preview = null, last_message_id = null,
    last_message_at = (select max(m.created_at) from public.messages m
      where m.conversation_id = c.id and m.sender_id <> v_job.subject_id)
    where c.id in (select conversation_id from public.messages where sender_id = v_job.subject_id);
  -- Direct-pair dedupe IDs have no FK. Replace the deleted subject with a fresh
  -- per-conversation random surrogate while keeping other senders' messages.
  with pairs as (
    select id, case when pair_low = v_job.subject_id then pair_high else pair_low end as other,
      gen_random_uuid() as anonymous
    from public.conversations where pair_low = v_job.subject_id or pair_high = v_job.subject_id
  ) update public.conversations c set pair_low = least(p.other, p.anonymous), pair_high = greatest(p.other, p.anonymous)
    from pairs p where c.id = p.id;
  -- Typed FKs remove account-owned rows and dependent reply threads. Other
  -- accounts' independent content survives; SET NULL repairs its typed links.
  delete from public.profiles where id = v_job.subject_id;
  update public.account_deletion_jobs set phase = 'auth', updated_at = clock_timestamp() where id = p_job;
  return jsonb_build_object('ready', true);
end;
$$;
revoke execute on function public.account_deletion_cleanup_content(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_cleanup_content(uuid, uuid) to service_role;

create function public.account_deletion_finish(p_job uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs;
begin
  perform app.account_worker_only();
  perform app.account_lock_private_images();
  v_job := app.account_deletion_fence(p_job, p_lease);
  if v_job.phase <> 'auth' or exists (select 1 from auth.users where id = v_job.subject_id)
    or exists (select 1 from public.profiles where id = v_job.subject_id)
    or exists (select 1 from public.account_deletion_media where deletion_job_id = p_job and state <> 'removed')
    or exists (select 1 from storage.objects o where
      coalesce(to_jsonb(o)->>'owner_id', to_jsonb(o)->>'owner') = v_job.subject_id::text
      or split_part(o.name, '/', 1) = v_job.subject_id::text
      or exists (select 1 from public.account_deletion_media m where m.deletion_job_id = p_job
        and m.bucket_id = o.bucket_id and m.object_path = o.name)) then
    raise exception 'Provider cleanup is not complete' using errcode = '55000', hint = 'provider_unavailable';
  end if;
  delete from public.account_deletion_media where deletion_job_id = p_job;
  update public.account_deletion_jobs set state = 'completed', phase = 'complete', subject_id = null,
    request_key = null, lease_token = null, lease_expires_at = null, error_code = null,
    completed_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_job;
  return jsonb_build_object('id', p_job, 'state', 'completed', 'phase', 'complete');
end;
$$;
revoke execute on function public.account_deletion_finish(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_finish(uuid, uuid) to service_role;

create function public.account_deletion_fail(p_job uuid, p_lease uuid, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs;
begin
  v_job := app.account_deletion_fence(p_job, p_lease);
  if p_code not in ('cleanup_failed', 'provider_unavailable', 'media_cleanup_failed', 'media_ownership_review', 'shared_media_ownership') then
    raise exception 'Invalid privacy-safe cleanup error code' using errcode = '22023';
  end if;
  update public.account_deletion_jobs set state = case
      when p_code in ('media_ownership_review', 'shared_media_ownership') then 'blocked'
      when attempts >= 5 then 'failed' else 'retry' end,
    error_code = p_code, lease_token = null, lease_expires_at = null,
    next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, (30 * power(2, attempts - 1))::integer)),
    updated_at = clock_timestamp() where id = p_job;
end;
$$;
revoke execute on function public.account_deletion_fail(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_fail(uuid, uuid, text) to service_role;

create function public.account_deletion_yield(p_job uuid, p_lease uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job public.account_deletion_jobs;
begin
  v_job := app.account_deletion_fence(p_job, p_lease);
  if not exists (select 1 from public.account_deletion_media where deletion_job_id = p_job and state = 'removed')
    or not exists (select 1 from public.account_deletion_media where deletion_job_id = p_job and state = 'pending') then
    raise exception 'No bounded cleanup progress to yield' using errcode = '22023';
  end if;
  update public.account_deletion_jobs set state = 'queued', phase = 'media',
    attempts = greatest(0, attempts - 1), lease_token = null, lease_expires_at = null,
    next_attempt_at = clock_timestamp() + interval '1 second', error_code = null,
    updated_at = clock_timestamp() where id = p_job;
end;
$$;
revoke execute on function public.account_deletion_yield(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_yield(uuid, uuid) to service_role;

create function public.account_deletion_resume(p_job uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform app.account_worker_only();
  update public.account_deletion_jobs set state = 'retry', attempts = 0, next_attempt_at = clock_timestamp(),
    error_code = null, updated_at = clock_timestamp() where id = p_job and state in ('blocked', 'failed');
  return found;
end;
$$;
revoke execute on function public.account_deletion_resume(uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_resume(uuid) to service_role;
