-- ---------------------------------------------------------------------------
-- 0016_backfill_profiles.sql
--
-- Give a profile row to any auth user that does not have one.
--
-- Why this is needed at all: public.profiles is populated by the
-- on_auth_user_created trigger added in 0004, and a trigger only fires for rows
-- inserted after it exists. The order in which first-time setup actually happens
-- is:
--
--   1. create the Supabase project
--   2. sign up, to check the sign-up form works
--   3. apply the migrations
--
-- which leaves step 2's user holding an auth row and no profile. Nothing
-- recovers from that on its own. The account can still sign in -- the session is
-- valid, the header renders -- but every page that reads the signed-in profile
-- finds nothing, so the account is signed in and unusable at the same time,
-- which is a considerably more confusing failure than being locked out.
--
-- The derivation below repeats app.handle_new_user's coalesce chain instead of
-- calling it. That function is a trigger function: it reads NEW, so it cannot be
-- invoked from a select. If the username or display-name rules change there,
-- change them here too -- tests/db/schema.test.ts executes this file against a
-- user inserted with the trigger disabled and checks the result satisfies the
-- same constraints.
--
-- Idempotent by `where not exists` and `on conflict do nothing`, so re-running it
-- is a no-op rather than an error. No trusted-write marker is needed: the guard
-- trigger on profiles (profiles_protect_columns) is BEFORE UPDATE only, and
-- inserts are not gated.
-- ---------------------------------------------------------------------------

insert into public.profiles (id, username, display_name, avatar_url)
select
  u.id,

  -- Collision-proof placeholder derived from the user's own uuid. Onboarding is
  -- where a real handle gets chosen; this only has to be unique and legal.
  'u' || substr(replace(u.id::text, '-', ''), 1, 12),

  left(
    coalesce(
      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(split_part(coalesce(u.email, ''), '@', 1)), ''),
      'Student'
    ),
    80
  ),

  coalesce(
    nullif(btrim(u.raw_user_meta_data ->> 'avatar_url'), ''),
    nullif(btrim(u.raw_user_meta_data ->> 'picture'), '')
  )

from auth.users u
where u.deleted_at is null
  and not exists (
    select 1 from public.profiles p where p.id = u.id
  )
on conflict (id) do nothing;
