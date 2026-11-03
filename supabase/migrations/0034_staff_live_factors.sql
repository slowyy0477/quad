-- Forward-only staff capability hardening. An AAL2 JWT can outlive factor
-- removal; require CURRENT owned verified enrollment matching its fresh AMR.
-- Provider contract (read-only; this migration never changes Auth tables):
-- https://github.com/supabase/auth/blob/master/migrations/20221003041349_add_mfa_schema.up.sql
-- https://supabase.com/docs/guides/auth/auth-mfa
--
-- Replace only the existing private predicate. The public boolean RPC, role
-- predicates, domain policies, lifecycle reauthentication and grants stay put.
create or replace function app.staff_session_assured()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb;
  v_user uuid;
  v_session uuid;
  v_sessions regclass;
  v_factors regclass;
  v_factor_status regtype;
  v_factor_type regtype;
  v_live boolean := false;
  v_live_factor boolean := false;
  v_method jsonb;
  v_kind text;
  v_recent_types text[] := array[]::text[];
  v_timestamp numeric;
  v_now numeric;
begin
  -- Initialise inside the exception boundary: malformed subject/claim input
  -- or unreadable platform state must return false, not a provider exception.
  v_claims := auth.jwt();
  v_user := auth.uid();
  v_now := extract(epoch from statement_timestamp());
  if v_user is null
     or jsonb_typeof(v_claims) is distinct from 'object'
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
     or jsonb_typeof(v_claims->'session_id') is distinct from 'string'
     or jsonb_typeof(v_claims->'amr') is distinct from 'array' then
    return false;
  end if;

  -- Runtime resolution keeps the migration compatible with the minimal shim.
  -- Missing tables, views masquerading as provider tables, dropped/wrongly
  -- typed columns and non-provider enrollment enums all fail closed.
  v_sessions := to_regclass('auth.sessions');
  v_factors := to_regclass('auth.mfa_factors');
  v_factor_status := to_regtype('auth.factor_status');
  v_factor_type := to_regtype('auth.factor_type');
  if v_sessions is null or v_factors is null
     or v_factor_status is null or v_factor_type is null
     or not exists (
       select 1 from pg_catalog.pg_class
        where oid = v_sessions and relkind in ('r', 'p')
     )
     or not exists (
       select 1 from pg_catalog.pg_class
        where oid = v_factors and relkind in ('r', 'p')
     )
     or (select count(*) from pg_catalog.pg_type
          where oid in (v_factor_status, v_factor_type) and typtype = 'e') <> 2
     or (select count(*) from pg_catalog.pg_enum
          where enumtypid = v_factor_status and enumlabel in ('unverified', 'verified')) <> 2
     or (select count(*) from pg_catalog.pg_enum
          where enumtypid = v_factor_type and enumlabel in ('totp', 'webauthn')) <> 2
     or (select count(*) from pg_catalog.pg_attribute
          where attrelid = v_sessions and attnum > 0 and not attisdropped and attnotnull
            and attname in ('id', 'user_id') and atttypid = 'uuid'::regtype) <> 2
     or (select count(*) from pg_catalog.pg_attribute
          where attrelid = v_factors and attnum > 0 and not attisdropped and attnotnull
            and (
              (attname in ('id', 'user_id') and atttypid = 'uuid'::regtype)
              or (attname = 'status' and atttypid = v_factor_status)
              or (attname = 'factor_type' and atttypid = v_factor_type)
            )) <> 4 then
    return false;
  end if;

  v_session := (v_claims->>'session_id')::uuid;
  execute 'select exists (select 1 from auth.sessions where id = $1 and user_id = $2)'
    into v_live using v_session, v_user;
  if v_live is distinct from true then return false; end if;

  for v_method in select value from jsonb_array_elements(v_claims->'amr') loop
    -- Same numeric, integral timestamp contract as the server helper. A quoted
    -- timestamp, JWT refresh time or editable metadata is not MFA proof.
    if jsonb_typeof(v_method) = 'object'
       and jsonb_typeof(v_method->'method') = 'string'
       and jsonb_typeof(v_method->'timestamp') = 'number'
       and coalesce(v_method->>'timestamp', '') ~ '^[0-9]{1,12}$' then
      v_kind := case v_method->>'method'
        when 'totp' then 'totp'
        when 'mfa/totp' then 'totp'
        when 'webauthn' then 'webauthn'
        when 'mfa/webauthn' then 'webauthn'
        else null
      end;
      v_timestamp := (v_method->>'timestamp')::numeric;
      if v_kind is not null and v_timestamp >= v_now - 300
         and v_timestamp <= v_now + 30
         and not (v_kind = any(v_recent_types)) then
        v_recent_types := array_append(v_recent_types, v_kind);
      end if;
    end if;
  end loop;
  if cardinality(v_recent_types) = 0 then return false; end if;

  -- At most two accepted types, bound as parameters. Project only a boolean;
  -- never factor IDs, secrets, phone data or another subject's enrollment.
  execute 'select exists (
    select 1 from auth.mfa_factors
     where user_id = $1 and status = ''verified''
       and factor_type::text = any($2::text[])
  )' into v_live_factor using v_user, v_recent_types;
  return v_live_factor is true;
exception when others then
  -- Provider schema/permission/runtime failures are refusals, with no raw logs.
  return false;
end;
$$;
revoke execute on function app.staff_session_assured()
  from public, anon, authenticated, service_role;

comment on function public.staff_session_assured() is
  'Current caller-only staff assurance: live session, active account, AAL2, MFA within five minutes, and current owned verified TOTP/WebAuthn matching that method. Returns only a boolean.';
