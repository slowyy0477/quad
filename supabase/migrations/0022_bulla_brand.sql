-- Bulla branding must not make official-looking handles available for signup.
-- Keep legacy reservations and existing user profiles intact.
insert into public.reserved_usernames (username, reason)
values
  ('bulla', 'brand'),
  ('bullaapp', 'brand'),
  ('bullasupport', 'brand')
on conflict (username) do nothing;
