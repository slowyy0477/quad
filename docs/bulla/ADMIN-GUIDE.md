# Bulla — owner and administrator guide

Updated 2 November 2026, Asia/Karachi. Read [STATUS.md](STATUS.md) for actual
verification and [FREE-HOSTING.md](FREE-HOSTING.md) for deployment progress.
The local preview is not a public deployment. Accounts and roles were not
changed when writing this guide.

## Your accounts are separate

| Account or role | Authority |
| --- | --- |
| Bulla `admin` | Moderator tools, administrator bug triage and the private-local data viewer. |
| Bulla `moderator` | Reports, university-request review and audit reading. |
| Supabase/Netlify project owner | Infrastructure, configuration and authorized database role changes. Not granted by a Bulla staff role. |
| Project owner/maintainer or conversation admin | That project's/group's controls only; not site staff. |

Staff use their own personal account at `/login`. There is no separate admin
login, shared/default public password, or in-app staff grant/revoke interface.
An ordinary Bulla admin cannot appoint moderators through the website yet.
The verified infrastructure owner can grant the role using the workflow below.

## Sign in to your existing private preview

1. Open `http://127.0.0.1:3000/login` on the computer running Bulla.
2. Use your account **email**, not its public username. Obtain any previously
   provisioned credentials from your password manager or private local file
   yourself. Never paste passwords, keys, codes or QR images into chat.
3. Open `/admin`, or the campus menu's **Site administration** link.
4. To rotate your own known password, use `/settings/password`, enter the
   current password and a different new password, then sign in again.
5. Local accounts have no email verification/recovery, Google login or hosted
   MFA. They do not become public accounts merely by deploying the app.

Local credential artifacts and sensitive backups may exist under
`D:/All tasks + Automations/Bulla-Recovery/credentials`. Keep them private,
outside Git, deployment uploads, screenshots and shared logs. A D-drive path
alone is not an access-control guarantee. Do not use a reset to discover a
password, and do not reuse demo credentials for public staff.

## Create a moderator's personal account

Each staff member should:

1. Register at `/signup` with an email they control and a unique password
   meeting the current 15-character minimum (hosted maximum: 72 UTF-8 bytes).
2. On the hosted site, complete the actual delivered email confirmation.
3. Finish `/onboarding`. Their profile may remain private.
4. Ask the owner to independently verify their identity and intended role.

The owner grants only the needed role. Nobody needs to disclose their password.
Admin already includes moderator capabilities; do not add a redundant
moderator role to an administrator.

## Grant an existing local account a role

This is an operator operation, not a website button. Select the exact existing
local store; never a test fixture, guessed path or manual JSON edit. The
recorded owner store is `D:/Quad/site-data/local.json`; verify it before use.

From `E:/Uni-Social-Network`, preview an existing-user grant:

```powershell
node 'E:/Uni-Social-Network/scripts/bulla/local-staff.mjs' --role moderator --email '<VERIFIED_PERSONAL_EMAIL>' --grant-existing --store 'D:/Quad/site-data/local.json' --credentials-dir 'D:/All tasks + Automations/Bulla-Recovery/credentials'
```

Omitting `--apply` is the supported dry-run; there is no `--dry-run` flag.
Review the exact store, user ID, email, role and proposed outcome. After the
owner approves that target, repeat the exact command with `--apply`.
Use `--role admin` only for a separately approved administrator grant.

Without `--reset`, the existing password/profile are preserved. An already-held
role returns `unchanged`. This helper can create a missing identity, so stop
if an existing-user workflow unexpectedly proposes `created`. Creation/rotation
writes a random credential to a private artifact; application also produces a
sensitive backup. A busy-store refusal is not permission to remove its lock.
No local revoke flag exists. Coordinate writes outside isolated verification.

## Grant a hosted moderator: exact verified Auth UUID

Only the authorized infrastructure owner/privileged database operator performs
this. A Bulla admin session, profile field, student JWT or public key cannot.
Do not run these examples against an unconfirmed or nonempty unrelated target.

1. Confirm the exact Supabase project and accepted forward schema.
2. Find the person's verified Auth account and exact UUID. In hosted mode,
   `profiles.id = auth.users.id`; local `usr_…`/`prf_…` IDs do not apply.
3. Verify email, profile completion, active/deletion state and existing roles.
4. Record the non-secret approval/reference and rehearse the exact change.

Read-only preflight:

```sql
select u.id as auth_user_uuid, u.email, u.email_confirmed_at,
       p.username, p.status, p.onboarding_completed, p.deleted_at,
       app.account_deletion_pending(u.id) as deletion_pending,
       array(select r.role from public.user_roles r
             where r.user_id = u.id order by r.role) as held_roles
from auth.users u
join public.profiles p on p.id = u.id
where u.id = '<TARGET_AUTH_USER_UUID>'::uuid;
```

Exact-account grant rehearsal — deliberately does not retain the change:

```sql
begin;

insert into public.user_roles (user_id, role, granted_by, note)
select u.id, 'moderator', null, 'Owner-approved grant; <CHANGE_REFERENCE>'
from auth.users u
join public.profiles p on p.id = u.id
where u.id = '<TARGET_AUTH_USER_UUID>'::uuid
  and lower(u.email) = lower('<VERIFIED_PERSONAL_EMAIL>')
  and u.email_confirmed_at is not null
  and u.deleted_at is null
  and (u.banned_until is null or u.banned_until <= now())
  and p.deleted_at is null
  and p.status = 'active'
  and p.onboarding_completed = true
  and not app.account_deletion_pending(u.id)
on conflict (user_id, role) do nothing
returning user_id, role, granted_at, note;

rollback;
```

After a reviewed rehearsal and approval, replace only the final `rollback`
with `commit`. Require the expected exact row; zero returned rows are not a
new grant. An already-held role must be verified separately. For a first admin,
use a separately approved exact-account grant with the single role literal
changed to `'admin'`.

`granted_by` is intentionally null: a dashboard owner may not have a Bulla
Auth UUID. Set it only to an independently verified operator UUID. Record
project, target UUID, role, operator, approval and outcome externally without
secrets; this operation does not automatically append a report-decision audit.
These SQL templates still require actual hosted acceptance.

The legacy `npm run create-admin` bootstrap is separate. Do not run it as a
shortcut to verify another person's email or rotate their password. Its policy
hardening/acceptance state is tracked in STATUS; the preferred staff workflow
is personal signup, real email verification, then an exact existing-user grant.
Never put `ADMIN_EMAIL`/`ADMIN_PASSWORD` in the hosting environment.

## Revoke a moderator

There is no in-app offboarding button. The authorized owner can rehearse this
exact-target operation:

```sql
begin;
delete from public.user_roles
where user_id = '<VERIFIED_TARGET_AUTH_UUID>'::uuid
  and role = 'moderator'
returning user_id, role;
rollback;
```

Commit only after the target/outcome and approval are verified. Removing a
moderator row does not remove a separate admin role. Verify refusal with the
former staff session. Do not delete the account or revoke broad email matches.
Admin offboarding needs a separate plan retaining another active,
MFA-accepted administrator; raw privileged SQL does not guarantee last-admin
lockout protection. Session revocation is a separate authorized operation.

## Hosted staff MFA

1. Sign in to the approved hosted site and open `/settings/security`.
2. Enter **Authenticator name** → **Create setup QR**. Scan the private QR in
   your authenticator, then **Verify and finish setup** with the current code.
3. For an enrolled account, choose **Authenticator** → **Verify staff session**.
4. Continue only after fresh live staff assurance, using **Continue to staff
   tools** or `/admin`. A password/Google login or enrollment alone is not enough.
5. Reverify when the five-minute assurance expires. Removed factors, revoked/
   stale sessions or failed provider checks must remain access refusals.

This UI supports TOTP, not security-key/phone challenges, factor removal or
recovery-code generation. Lost factors require another enrolled authenticator
or independently verified operator recovery; email recovery is not an MFA
bypass. Real hosted factor/live-session verification remains a launch gate.

## Administrator workspace

| Page | What you can do |
| --- | --- |
| `/admin` | Review reports and individual decisions; see the moderator guide. No bulk moderation or self-target decisions. |
| `/admin/universities` | Approve/reject pending institution requests with reasons. Not student identity verification. |
| `/admin/audit` | Read actors/actions/targets/reasons and UTC times; no edit/delete control. |
| `/admin/bug-reports` | Set Received, Looked at, Fixed or Closed without a fix. Marking Fixed is not evidence that code was fixed. |
| `/admin/data` | Read-only private-local counts and first four rows per table. Not a hosted database editor or role manager. |

The report queue exposes reported messages for review, not unrestricted thread
browsing. However, local **All data** previews every local table, potentially
including private messages/account rows, with selected named-field masking.
Treat it as a highly privileged private operator surface, not a shared demo.
Infrastructure operators have separate database powers. Never promise blanket
private-content or complete nested-secret masking.

For report decisions, conflicts, suspensions and correction limitations, read
[MODERATOR-GUIDE.md](MODERATOR-GUIDE.md). For safe publication and later updates,
read [FREE-HOSTING.md](FREE-HOSTING.md). No public URL, production staff account
or 50,000-user capacity has been handed over yet.
