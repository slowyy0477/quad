-- Forward-only image account-state correction. Never rewrite 0027 or account
-- records, resurrect sessions, clear permanent disables, or mutate Storage rows.
-- Expired TEMPORARY suspension is usable; deletion, bans and deactivation are not.

create function app.bulla_image_account_active(p_subject uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = p_subject and p.deleted_at is null and u.deleted_at is null
      and (p.status = 'active' or
        (p.status = 'suspended' and p.suspended_until is not null and p.suspended_until <= now()))
      and not app.account_deletion_pending(p.id)
      -- Provider ban/disable state remains authoritative even if a profile has
      -- stale "active" or expired-suspension state. JSON lookup tolerates the
      -- intentionally minimal test shim without adding columns to provider tables.
      and (to_jsonb(u)->>'disabled_at') is null
      and (
        nullif(to_jsonb(u)->>'banned_until', '') is null
        or (to_jsonb(u)->>'banned_until')::timestamptz <= now()
      )
  );
$$;
revoke execute on function app.bulla_image_account_active(uuid)
  from public, anon, authenticated, service_role;

create or replace function app.bulla_image_target_owner(p_actor uuid, p_kind text, p_project uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not app.bulla_image_account_active(p_actor) then return null; end if;
  if p_kind = 'avatar' and p_project is null then return p_actor; end if;
  if p_kind <> 'project-cover' or p_project is null then return null; end if;
  select p.owner_id into v_owner from public.projects p
    where p.id = p_project and p.deleted_at is null and p.moderation_status = 'active'
      and app.bulla_image_account_active(p.owner_id)
      and not app.is_blocked_either_way(p_actor, p.owner_id)
      and app.can_manage_project(p.id, p_actor);
  return v_owner;
end $$;
revoke execute on function app.bulla_image_target_owner(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- Preserve 0027's original association, current URL, target visibility, block
-- checks and read audience. This does NOT turn expired suspension into a grant
-- to private profiles/projects or to an unrelated/stale image URL.
create or replace function app.bulla_can_read_image(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.private_images i
    join public.profiles owner on owner.id = i.owner_id
    where i.id = p_id and i.state = 'ready'
      and app.bulla_image_account_active(i.owner_id)
      and (auth.uid() is null or app.bulla_image_account_active(auth.uid()))
      and not app.is_blocked_either_way(i.owner_id, auth.uid())
      and (
        (i.kind = 'avatar' and owner.id = i.profile_id
          and owner.avatar_url = '/api/images/' || i.id::text and app.can_view_profile(i.profile_id))
        or
        (i.kind = 'project-cover' and exists (
          select 1 from public.projects p where p.id = i.project_id and p.owner_id = i.owner_id
            and p.deleted_at is null and p.moderation_status = 'active'
            and p.cover_url = '/api/images/' || i.id::text and app.can_view_project(p.id)
        ))
      )
  );
$$;
revoke execute on function app.bulla_can_read_image(uuid) from public;
grant execute on function app.bulla_can_read_image(uuid) to anon, authenticated, service_role;

-- FAIL CLOSED. Installed Storage deletion is by path, not exact object version.
-- A separate SQL identity check/tombstone cannot make that later HTTP deletion
-- atomic: a replacement can appear between the check and the API call.
--
-- No orphan-delete authority, tombstone table, bucket sweep, Storage DML, or
-- lifecycle rewrite is installed by this migration. Existing authorized reads
-- remain usable. The guarded adapter must refuse hosted writes while this is
-- false, even with a service key/private bucket. This is not an operator setting
-- or environment opt-in: a future reviewed protocol/migration is required.
create function public.bulla_image_upload_readiness()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 1,
    'enabled', false,
    'code', 'hosted_image_uploads_disabled'
  );
$$;
revoke execute on function public.bulla_image_upload_readiness()
  from public, anon, authenticated, service_role;
grant execute on function public.bulla_image_upload_readiness() to service_role;
