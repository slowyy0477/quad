-- Staff capabilities belong to this verified caller, not merely to a stored
-- role. Preserve the role table and all domain policies; strengthen the shared
-- predicates they already use. Never enable this by an editable profile field.

create function app.staff_session_assured()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_user uuid := auth.uid();
  v_session uuid;
  v_live boolean := false;
  v_method jsonb;
  v_timestamp numeric;
  v_now numeric := extract(epoch from statement_timestamp());
begin
  if v_user is null
     or not exists (
       select 1 from public.user_roles
        where user_id = v_user and role in ('admin', 'moderator')
     )
     or not app.account_lifecycle_access()
     or app.is_account_restricted(v_user)
     or coalesce(v_claims->>'is_anonymous', 'false') <> 'false'
     or coalesce(v_claims->>'aal', '') <> 'aal2'
     or coalesce(v_claims->>'session_id', '') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(v_claims->'amr') is distinct from 'array'
     or to_regclass('auth.sessions') is null then
    return false;
  end if;

  v_session := (v_claims->>'session_id')::uuid;
  execute 'select exists (select 1 from auth.sessions where id = $1 and user_id = $2)'
    into v_live using v_session, v_user;
  if not v_live then return false; end if;

  for v_method in select value from jsonb_array_elements(v_claims->'amr') loop
    if v_method->>'method' in ('totp', 'mfa/totp', 'webauthn', 'mfa/webauthn')
       and coalesce(v_method->>'timestamp', '') ~ '^[0-9]{1,12}$' then
      v_timestamp := (v_method->>'timestamp')::numeric;
      if v_timestamp >= v_now - 300 and v_timestamp <= v_now + 30 then
        return true;
      end if;
    end if;
  end loop;
  return false;
end;
$$;
revoke execute on function app.staff_session_assured()
  from public, anon, authenticated, service_role;

create function public.staff_session_assured()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select app.staff_session_assured(); $$;
revoke execute on function public.staff_session_assured()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_session_assured() to authenticated;

-- Role inspection for a TARGET remains app.has_role(). Capability checks must
-- bind to the current caller. Supplying another administrator's UUID grants
-- nothing, and a revoked session cannot retain staff reads through an old JWT.
create or replace function app.is_admin(v_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = ''
as $$
  select v_user is not null and v_user = auth.uid()
    and app.has_role('admin', v_user) and app.staff_session_assured();
$$;

create or replace function app.is_moderator(v_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = ''
as $$
  select v_user is not null and v_user = auth.uid()
    and (app.has_role('admin', v_user) or app.has_role('moderator', v_user))
    and app.staff_session_assured();
$$;

-- Preserve the existing conflict-of-interest rule even when the TARGET is not
-- the authenticated caller. A target's staff role is a fact, not a capability.
create or replace function app.assert_moderation_allowed(v_actor uuid, v_target uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if v_actor is null then
    raise exception 'A moderation action needs a signed-in actor'
      using errcode = '42501', hint = 'actor_required';
  end if;
  if v_target is null then return; end if;
  if v_target = v_actor then
    raise exception 'You cannot decide a report about yourself'
      using errcode = '42501', hint = 'self_moderation_forbidden';
  end if;
  if app.has_role('admin', v_target) and not app.is_admin(v_actor) then
    raise exception 'Reports about an administrator are decided by an administrator'
      using errcode = '42501', hint = 'admin_target_forbidden';
  end if;
end;
$$;

comment on function public.staff_session_assured() is
  'Current caller-only staff assurance: live session, active account, AAL2 and MFA within five minutes. Returns only a boolean.';
