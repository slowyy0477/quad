-- Forward-only S10 assurance parity. Do not rewrite 0026 or Auth-owned tables.
-- Supabase's enrollment contract is user_id + status = 'verified':
-- https://supabase.com/docs/guides/auth/auth-mfa
-- https://github.com/supabase/auth/blob/master/migrations/20221003041349_add_mfa_schema.up.sql
--
-- Only the existing private lifecycle predicate changes. Public RPC signatures,
-- ownership checks, worker grants, revocation and cleanup policy are unchanged.
create or replace function app.account_require_reauthentication()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_subject uuid := auth.uid();
  v_claims jsonb := auth.jwt();
  v_method jsonb;
  v_recent_password boolean := false;
  v_recent_mfa boolean := false;
  v_verified_factor boolean;
  v_timestamp numeric;
  v_now numeric := extract(epoch from clock_timestamp());
  v_session uuid;
  v_live boolean;
  v_staff boolean;
begin
  if not app.account_lifecycle_access() then
    raise exception 'Account is unavailable'
      using errcode = '42501', hint = 'account_unavailable';
  end if;
  if coalesce(v_claims->>'is_anonymous', 'false') <> 'false'
     or coalesce(v_claims->>'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(v_claims->'amr') is distinct from 'array'
     or to_regclass('auth.sessions') is null then
    raise exception 'Fresh provider verification is required'
      using errcode = '42501', hint = 'provider_assurance_required';
  end if;
  v_session := (v_claims->>'session_id')::uuid;
  -- Runtime platform lookup: migrations can compile in a minimal test shim,
  -- but missing/unreadable/malformed session state can never grant access.
  begin
    execute 'select exists (select 1 from auth.sessions where id = $1 and user_id = $2)'
      into v_live using v_session, v_subject;
  exception when others then
    raise exception 'Provider session verification is unavailable'
      using errcode = '42501', hint = 'provider_assurance_required';
  end;
  if v_live is distinct from true then
    raise exception 'Session is no longer available'
      using errcode = '42501', hint = 'signed_out';
  end if;

  for v_method in select value from jsonb_array_elements(v_claims->'amr') loop
    -- Match the adapter's numeric timestamp contract, not a quoted timestamp,
    -- a refreshed JWT's iat, user metadata or an AAL label without fresh AMR.
    if jsonb_typeof(v_method) = 'object'
       and jsonb_typeof(v_method->'timestamp') = 'number'
       and jsonb_typeof(v_method->'method') = 'string'
       and coalesce(v_method->>'timestamp', '') ~ '^[0-9]{1,12}$' then
      v_timestamp := (v_method->>'timestamp')::numeric;
      if v_timestamp >= v_now - 300 and v_timestamp <= v_now + 30 then
        v_recent_password := v_recent_password or v_method->>'method' = 'password';
        v_recent_mfa := v_recent_mfa or v_method->>'method' in (
          'totp', 'mfa/totp', 'webauthn', 'mfa/webauthn'
        );
      end if;
    end if;
  end loop;
  v_recent_mfa := v_recent_mfa and coalesce(v_claims->>'aal', '') = 'aal2';

  -- Raw role truth, not an actor-privilege helper. 0033 may make is_moderator /
  -- is_admin return false for unassured staff; that must NOT skip their MFA.
  select exists (
    select 1 from public.user_roles
    where user_id = v_subject and role in ('admin', 'moderator')
  ) into v_staff;
  if v_recent_mfa then return; end if;
  if v_staff or not v_recent_password then
    raise exception 'Fresh strong provider verification is required'
      using errcode = '42501', hint = 'provider_assurance_required';
  end if;

  -- Only a password-only grant needs proof that no verified factor is enrolled.
  -- Unknown factor state requires MFA, never a password-only fallback. A caller
  -- already supplying fresh strong MFA has satisfied that stronger requirement.
  if to_regclass('auth.mfa_factors') is null then
    raise exception 'Provider enrollment verification is unavailable'
      using errcode = '42501', hint = 'provider_assurance_required';
  end if;
  begin
    execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status = ''verified'')'
      into v_verified_factor using v_subject;
  exception when others then
    -- Fixed privacy-safe refusal; never persist/return a provider exception or
    -- read factor IDs, secrets, phone numbers or another account's factor rows.
    raise exception 'Provider enrollment verification is unavailable'
      using errcode = '42501', hint = 'provider_assurance_required';
  end;
  if v_verified_factor is distinct from false then
    raise exception 'Fresh strong provider verification is required'
      using errcode = '42501', hint = 'provider_assurance_required';
  end if;
end;
$$;
revoke execute on function app.account_require_reauthentication()
  from public, anon, authenticated, service_role;
