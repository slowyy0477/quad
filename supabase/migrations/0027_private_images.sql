-- Bulla normalized avatar/project covers ONLY, not general attachments or scanning.
-- No Storage object INSERT/UPDATE/DELETE via SQL. Object bytes use the Storage API.
-- Apply through the normal forward-migration process; this file is not deployment
-- evidence. 0024-0026 may belong to independent shared-checkout work.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bulla-private-images', 'bulla-private-images', false, 2097152, array['image/webp'])
on conflict (id) do update
set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/webp'];

create table public.private_images (
  id uuid primary key default gen_random_uuid()
    check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text not null check (kind in ('avatar', 'project-cover')),
  owner_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  profile_id uuid references public.profiles(id),
  project_id uuid references public.projects(id),
  state text not null default 'pending' check (state in ('pending', 'ready', 'retired')),
  byte_count integer not null check (byte_count > 0),
  width integer,
  height integer,
  sha256 text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '120 seconds',
  constraint private_images_target check (
    (kind = 'avatar' and profile_id is not null and profile_id = owner_id and project_id is null) or
    (kind = 'project-cover' and profile_id is null and project_id is not null)
  ),
  constraint private_images_bounds check (
    (kind = 'avatar' and byte_count <= 524288 and (width is null or width between 1 and 512)
      and (height is null or height between 1 and 512)) or
    (kind = 'project-cover' and byte_count <= 2097152 and (width is null or width between 1 and 1600)
      and (height is null or height between 1 and 900))
  ),
  constraint private_images_metadata check (
    (state = 'pending' and width is null and height is null and sha256 is null) or
    (state = 'retired' and width is null and height is null and sha256 is null) or
    (state in ('ready', 'retired') and width is not null and height is not null and sha256 is not null and sha256 ~ '^[a-f0-9]{64}$')
  )
);

comment on table public.private_images is
  'Server-owned immutable image associations. Pending/retired objects are unreadable; '
  'deletion requires Storage API cleanup first. Foreign keys deliberately do not cascade '
  'away orphan-cleanup metadata. Account hard deletion must retire/remove these first.';

create unique index private_images_current_avatar on public.private_images(profile_id)
  where kind = 'avatar' and state = 'ready';
create unique index private_images_current_project on public.private_images(project_id)
  where kind = 'project-cover' and state = 'ready';
create index private_images_owner on public.private_images(owner_id);
create index private_images_cleanup on public.private_images(state, expires_at);

alter table public.private_images enable row level security;
revoke all on table public.private_images from public, anon, authenticated, service_role;
grant select on table public.private_images to anon, authenticated, service_role;

-- One fixed-budget row per active actor, plus a global lock/counter row. No client
-- can pick a limit/window/identity, reset a counter or bypass a reservation.
create table app.private_image_budgets (
  subject text primary key,
  minute bigint not null default 0,
  minute_hits integer not null default 0,
  ten_minutes bigint not null default 0,
  ten_minute_hits integer not null default 0,
  day bigint not null default 0,
  day_hits integer not null default 0
);
revoke all on table app.private_image_budgets from public, anon, authenticated, service_role;
insert into app.private_image_budgets(subject) values ('global');

create function app.bulla_image_target_owner(p_actor uuid, p_kind text, p_project uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = p_actor and p.deleted_at is null and p.status = 'active') then
    return null;
  end if;
  if p_kind = 'avatar' and p_project is null then return p_actor; end if;
  if p_kind <> 'project-cover' or p_project is null then return null; end if;
  select p.owner_id into v_owner from public.projects p
    join public.profiles owner on owner.id = p.owner_id
    where p.id = p_project and p.deleted_at is null and p.moderation_status = 'active'
      and owner.deleted_at is null and owner.status = 'active'
      and not app.is_blocked_either_way(p_actor, p.owner_id)
      and app.can_manage_project(p.id, p_actor);
  return v_owner;
end $$;
revoke execute on function app.bulla_image_target_owner(uuid, text, uuid) from public, anon, authenticated, service_role;

create function app.bulla_private_images_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_privileged_role() then
    raise exception 'Private image metadata is server-owned' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.kind is distinct from old.kind or
       new.owner_id is distinct from old.owner_id or new.actor_id is distinct from old.actor_id or
       new.profile_id is distinct from old.profile_id or new.project_id is distinct from old.project_id or
       new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
      raise exception 'Private image association is immutable' using errcode = '42501';
    end if;
    if not ((old.state = 'pending' and new.state in ('ready', 'retired')) or
            (old.state = 'ready' and new.state = 'retired')) then
      raise exception 'Invalid private image state transition' using errcode = '23514';
    end if;
    if old.state <> 'pending' and
       (new.byte_count is distinct from old.byte_count or new.width is distinct from old.width or
        new.height is distinct from old.height or new.sha256 is distinct from old.sha256) then
      raise exception 'Normalized image metadata is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function app.bulla_private_images_guard() from public, anon, authenticated, service_role;
create trigger private_images_guard before insert or update on public.private_images
  for each row execute function app.bulla_private_images_guard();

-- Authorization follows the ORIGINAL association and the current URL, never the
-- uploader alone or a client-supplied profile/project pasted around the image ID.
create function app.bulla_can_read_image(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.private_images i
    join public.profiles owner on owner.id = i.owner_id
    where i.id = p_id and i.state = 'ready' and owner.deleted_at is null and owner.status = 'active'
      and (auth.uid() is null or exists (
        select 1 from public.profiles viewer where viewer.id = auth.uid()
          and viewer.deleted_at is null and viewer.status = 'active'
      ))
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
create policy private_images_current_read on public.private_images for select to anon, authenticated
  using (app.bulla_can_read_image(id));

create function app.bulla_can_read_image_path(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_name is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$' then
    return false;
  end if;
  return app.bulla_can_read_image(left(p_name, 36)::uuid);
end $$;
revoke execute on function app.bulla_can_read_image_path(text) from public;
grant execute on function app.bulla_can_read_image_path(text) to anon, authenticated, service_role;

-- Restrictive guards also defeat unrelated, overly broad permissive Storage
-- policies. UPDATE checks BOTH old/new bucket to prevent moving raw objects in.
create policy bulla_images_client_insert_guard on storage.objects as restrictive
  for insert to anon, authenticated with check (bucket_id <> 'bulla-private-images');
create policy bulla_images_client_update_guard on storage.objects as restrictive
  for update to anon, authenticated using (bucket_id <> 'bulla-private-images')
  with check (bucket_id <> 'bulla-private-images');
create policy bulla_images_client_delete_guard on storage.objects as restrictive
  for delete to anon, authenticated using (bucket_id <> 'bulla-private-images');
create policy bulla_images_read_guard on storage.objects as restrictive
  for select to anon, authenticated
  using (bucket_id <> 'bulla-private-images' or app.bulla_can_read_image_path(name));
create policy bulla_images_authorized_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'bulla-private-images' and app.bulla_can_read_image_path(name));

-- Existing legacy/provider URLs are not rewritten. Managed URLs must refer to
-- the correct ready image even if a client writes avatar_url/cover_url directly.
create function app.bulla_image_reference_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text; v_kind text; v_owner uuid;
begin
  if tg_table_name = 'profiles' then v_url := new.avatar_url; v_kind := 'avatar'; v_owner := new.id;
  else v_url := new.cover_url; v_kind := 'project-cover'; v_owner := new.owner_id; end if;
  if v_url is null or v_url not like '/api/images/%' then return new; end if;
  if not exists (
    select 1 from public.private_images i where v_url = '/api/images/' || i.id::text
      and i.state = 'ready' and i.kind = v_kind
      and ((v_kind = 'avatar' and i.profile_id = new.id and i.owner_id = new.id)
        or (v_kind = 'project-cover' and i.project_id = new.id and i.owner_id = v_owner))
  ) then
    raise exception 'Private image belongs to a different or inactive association' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function app.bulla_image_reference_guard() from public, anon, authenticated, service_role;
create trigger zz_bulla_avatar_reference before insert or update of avatar_url on public.profiles
  for each row execute function app.bulla_image_reference_guard();
create trigger zz_bulla_project_image_reference before insert or update of cover_url on public.projects
  for each row execute function app.bulla_image_reference_guard();

create function public.bulla_reserve_image(p_actor uuid, p_kind text, p_project uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_row public.private_images;
  v_minute bigint := floor(extract(epoch from clock_timestamp()) / 60);
  v_ten bigint := floor(extract(epoch from clock_timestamp()) / 600);
  v_day bigint := floor(extract(epoch from clock_timestamp()) / 86400);
  v_actor app.private_image_budgets; v_global app.private_image_budgets;
  v_allocation integer;
begin
  if not app.is_privileged_role() then raise exception 'Server-only image reservation' using errcode = '42501'; end if;
  -- Resolve the association AFTER acquiring the same lock as account deletion;
  -- a pre-lock read could otherwise outlive a queued/deactivated owner.
  perform 1 from app.private_image_budgets where subject = 'global' for update;
  v_owner := app.bulla_image_target_owner(p_actor, p_kind, p_project);
  if v_owner is null then return jsonb_build_object('error', 'upload_denied'); end if;
  -- Every reserve/commit/retire/forget takes this same row lock.
  insert into app.private_image_budgets(subject, minute, minute_hits, ten_minutes, ten_minute_hits, day, day_hits)
    values ('global', v_minute, 1, v_ten, 1, v_day, 1)
    on conflict (subject) do update set
      minute = v_minute, minute_hits = case when private_image_budgets.minute = v_minute then least(private_image_budgets.minute_hits + 1, 31) else 1 end,
      ten_minutes = v_ten, ten_minute_hits = case when private_image_budgets.ten_minutes = v_ten then least(private_image_budgets.ten_minute_hits + 1, 6) else 1 end,
      day = v_day, day_hits = case when private_image_budgets.day = v_day then least(private_image_budgets.day_hits + 1, 21) else 1 end
    returning * into v_global;
  insert into app.private_image_budgets(subject, minute, minute_hits, ten_minutes, ten_minute_hits, day, day_hits)
    values (p_actor::text, v_minute, 1, v_ten, 1, v_day, 1)
    on conflict (subject) do update set
      minute = v_minute, minute_hits = case when private_image_budgets.minute = v_minute then least(private_image_budgets.minute_hits + 1, 31) else 1 end,
      ten_minutes = v_ten, ten_minute_hits = case when private_image_budgets.ten_minutes = v_ten then least(private_image_budgets.ten_minute_hits + 1, 6) else 1 end,
      day = v_day, day_hits = case when private_image_budgets.day = v_day then least(private_image_budgets.day_hits + 1, 21) else 1 end
    returning * into v_actor;
  delete from app.private_image_budgets where subject <> 'global' and day < v_day - 1;
  if v_global.minute_hits > 30 or v_actor.ten_minute_hits > 5 or v_actor.day_hits > 20
     or (select count(*) from public.private_images where state = 'pending') >= 4
     or (select count(*) from public.private_images where state = 'pending' and actor_id = p_actor) >= 2 then
    return jsonb_build_object('error', 'upload_rate_limited');
  end if;
  v_allocation := case when p_kind = 'avatar' then 524288 else 2097152 end;
  if (select count(*) from public.private_images) >= 512
     or (select count(*) from public.private_images where owner_id = v_owner) >= 20
     or (select coalesce(sum(byte_count), 0) from public.private_images) + v_allocation > 268435456
     or (select coalesce(sum(byte_count), 0) from public.private_images where owner_id = v_owner) + v_allocation > 16777216 then
    return jsonb_build_object('error', 'image_quota_exceeded');
  end if;
  insert into public.private_images(kind, owner_id, actor_id, profile_id, project_id, byte_count)
    values (p_kind, v_owner, p_actor, case when p_kind = 'avatar' then p_actor end, p_project, v_allocation)
    returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'ownerId', v_row.owner_id,
    'actorId', v_row.actor_id, 'profileId', v_row.profile_id, 'projectId', v_row.project_id, 'expiresAt', v_row.expires_at);
end $$;
revoke execute on function public.bulla_reserve_image(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.bulla_reserve_image(uuid, text, uuid) to service_role;

create function public.bulla_commit_image(p_id uuid, p_actor uuid, p_sha256 text, p_bytes integer, p_width integer, p_height integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.private_images; v_owner uuid; v_url text;
begin
  if not app.is_privileged_role() then raise exception 'Server-only image commit' using errcode = '42501'; end if;
  perform 1 from app.private_image_budgets where subject = 'global' for update;
  select * into v_row from public.private_images where id = p_id for update;
  if v_row.id is null or v_row.state <> 'pending' or v_row.actor_id <> p_actor or v_row.expires_at <= clock_timestamp() then
    return jsonb_build_object('error', 'upload_denied');
  end if;
  -- Serialize with concurrent owner/role/deletion changes, then recheck rights.
  perform 1 from public.profiles where id = p_actor or id = v_row.owner_id order by id for update;
  if v_row.project_id is not null then
    perform 1 from public.projects where id = v_row.project_id for update;
    perform 1 from public.project_members where project_id = v_row.project_id and profile_id = p_actor for update;
  end if;
  v_owner := app.bulla_image_target_owner(p_actor, v_row.kind, v_row.project_id);
  if v_owner is distinct from v_row.owner_id then return jsonb_build_object('error', 'upload_denied'); end if;
  if p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' or p_bytes is null or p_bytes < 1
     or p_width is null or p_height is null or p_width < 1 or p_height < 1
     or (v_row.kind = 'avatar' and (p_bytes > 524288 or p_width > 512 or p_height > 512))
     or (v_row.kind = 'project-cover' and (p_bytes > 2097152 or p_width > 1600 or p_height > 900)) then
    return jsonb_build_object('error', 'invalid_raster');
  end if;
  update public.private_images set state = 'retired' where state = 'ready' and kind = v_row.kind
    and profile_id is not distinct from v_row.profile_id and project_id is not distinct from v_row.project_id;
  update public.private_images set state = 'ready', byte_count = p_bytes, width = p_width, height = p_height, sha256 = p_sha256
    where id = p_id;
  v_url := '/api/images/' || p_id::text;
  if v_row.kind = 'avatar' then update public.profiles set avatar_url = v_url where id = v_row.profile_id;
  else update public.projects set cover_url = v_url where id = v_row.project_id; end if;
  return jsonb_build_object('id', p_id, 'url', v_url, 'kind', v_row.kind, 'width', p_width, 'height', p_height,
    'bytes', p_bytes, 'contentType', 'image/webp');
end $$;
revoke execute on function public.bulla_commit_image(uuid, uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.bulla_commit_image(uuid, uuid, text, integer, integer, integer) to service_role;

-- Retirement happens BEFORE API deletion. Unknown commit outcomes cannot delete
-- an image that actually committed: this returns false for ready records.
create function public.bulla_retire_image(p_id uuid, p_expired_only boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row public.private_images;
begin
  if not app.is_privileged_role() then raise exception 'Server-only image retirement' using errcode = '42501'; end if;
  perform 1 from app.private_image_budgets where subject = 'global' for update;
  select * into v_row from public.private_images where id = p_id for update;
  if v_row.id is null or v_row.state = 'ready' then return false; end if;
  if v_row.state = 'retired' then return true; end if;
  if p_expired_only and v_row.expires_at > clock_timestamp() then return false; end if;
  update public.private_images set state = 'retired' where id = p_id;
  return true;
end $$;
revoke execute on function public.bulla_retire_image(uuid, boolean) from public, anon, authenticated;
grant execute on function public.bulla_retire_image(uuid, boolean) to service_role;

create function public.bulla_forget_image(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_privileged_role() then raise exception 'Server-only image cleanup' using errcode = '42501'; end if;
  perform 1 from app.private_image_budgets where subject = 'global' for update;
  delete from public.private_images where id = p_id and state = 'retired';
  return found;
end $$;
revoke execute on function public.bulla_forget_image(uuid) from public, anon, authenticated;
grant execute on function public.bulla_forget_image(uuid) to service_role;

-- 0026 installs guards only on tables that exist at that migration. Enroll this
-- later table as well, without editing its independently owned lifecycle file.
do $lifecycle$
begin
  if to_regprocedure('app.install_account_lifecycle_table_guards()') is not null then
    perform app.install_account_lifecycle_table_guards();
  end if;
end;
$lifecycle$;
