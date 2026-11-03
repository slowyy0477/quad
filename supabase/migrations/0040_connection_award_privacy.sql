-- 0040 — Owner-only reads of the two automatic connection-count awards.
-- PROPOSAL ONLY, 2026-11-02. Version provisional; main must reserve/recheck it.
-- Additive restriction only. Preserve the original achievement SELECT/UPDATE
-- policies, lifecycle guards, columns, grants, award/pin/counter/notification
-- triggers, reauthenticated owner export and owner-authored achievement posts.
--
-- Hiding awarded_value alone would still expose the 1/25 connection threshold
-- through achievement_key, row existence, count, pin status or awarded_at.
-- Filter the entire automatic award row for every non-owner client instead.
-- There is intentionally no staff override and no catalogue/category rewrite.
-- Existing permissive policies and every applicable restrictive guard must
-- still pass; the owner branch is not an independent permission grant.
-- Trusted trigger/export definers retain their original ownership and grants.
-- No independent BEGIN/COMMIT: main's migration bundle owns the transaction.

create policy profile_achievements_connection_award_privacy
  on public.profile_achievements
  as restrictive
  for select
  to anon, authenticated
  using (
    profile_id = auth.uid()
    or achievement_key not in ('first_connection', 'connections_25')
  );

comment on policy profile_achievements_connection_award_privacy
  on public.profile_achievements is
  'Automatic first_connection/connections_25 receipts are visible only to their actual owner, subject to existing policies and guards. Other badge reads and explicit owner-authored posts retain their original rules.';
