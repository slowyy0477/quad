-- New accounts are private until the owner explicitly chooses publication.
-- Existing profiles and consent are preserved: deliberately no UPDATE.
alter table public.profiles alter column visibility set default 'private';

-- Metadata supplied to Auth is not consent. The hook explicitly inserts private
-- even if a provider/client supplied visibility or onboarding metadata.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_display text;
  v_avatar text;
begin
  v_username := 'u' || substr(replace(new.id::text, '-', ''), 1, 12);
  v_display := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Student'
  );
  v_avatar := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'picture'), '')
  );
  insert into public.profiles (
    id, username, display_name, avatar_url, visibility, onboarding_completed
  ) values (
    new.id, v_username, left(v_display, 80), v_avatar, 'private', false
  ) on conflict (id) do nothing;
  return new;
exception when others then
  -- Match the existing non-fatal signup hook; do not log submitted metadata.
  raise warning 'handle_new_user failed for %: %', new.id, sqlstate;
  return new;
end;
$$;
revoke execute on function app.handle_new_user() from public, anon, authenticated;
