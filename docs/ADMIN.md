# Administration

Two privileged roles exist in the database: `admin` and `moderator`. The **database
and interface code exist**, but hosted staff/MFA, authorization and operational
acceptance are unfinished. Current state is in [bulla/ISSUES.md](bulla/ISSUES.md)
and [STATUS.md](bulla/STATUS.md). The older screen table/operational notes below
are historical design rationale, not the current implementation ledger or
authority to change an account. The request proxy is `src/proxy.ts`.

---

## Creating the first admin

The following is an optional **hosted operator workflow**, not authorization to
run it as part of documentation or local UI checks.

```bash
npm run create-admin
```

[`scripts/create-admin.ts`](../scripts/create-admin.ts) reads operator variables
(loading `.env.local` before `.env`), creates or locates a Supabase Auth account,
then upserts a role in `public.user_roles`. It uses the service-role key, not an
ordinary staff session.

After an intentionally authorized bootstrap, remove `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from the bootstrap environment. Do not promise an in-app password
change after first sign-in: `/settings/password` is missing (S08). The script currently
checks a 12-character minimum, weaker than the application's signup policy; bootstrap
password policy and a verified staff password-change/MFA procedure remain gaps.

To grant a moderator role instead:

```bash
npm run create-admin -- --role moderator
```

The script prints the project host and the account email before acting, so you cannot
grant yourself admin on the wrong project without noticing.

### Bootstrap secrets and local demo accounts

The hosted bootstrap script has no hard-coded password and does not deliberately
write/log the supplied password. Keep bootstrap secrets out of source, screenshots
and task logs. Legacy local seeded/sample credentials are a separate development
mechanism, not production staff accounts; do not rename or erase them during branding.

[`scripts/local/make-admin.mjs`](../scripts/local/make-admin.mjs) is a different,
local-only helper. It targets the legacy `data/local.json` path directly and writes
a credential artifact; it is not the hosted script or an isolated-fixture check.
Its `existingRole` lookup is unused: without `--reset`, any existing account gets an
“already holds the admin role” message even without an admin grant. That operator
defect remains R22 in [ISSUES.md](bulla/ISSUES.md); the message is not role verification.
Do not run it against an owner's store merely to verify these docs.

### Why a script and not a first-run page

`public.user_roles` has **no** `INSERT` grant for `anon` or `authenticated`, and an
`app.forbid_write()` trigger blocks writes on top of that. Only the service role can
grant a role, and the service key never leaves the server.

That means there is no "make me an admin" request an attacker can forge, and no
first-run page that is a privilege-escalation hole until someone claims it. Roles also
live in their own table rather than on `profiles`, because a user who can update their
own profile row can update every granted column of it — see
[SECURITY.md](SECURITY.md) §4.

## What admins can and cannot see

Scope depends on the table, role and selected provider; there is no blanket
“staff cannot read private content” rule:

- **Passwords:** ordinary staff interfaces do not recover stored plaintext passwords.
  Local hashes/token fields are masked in the data inspector. Staff must not ask users
  for passwords; verified recovery is separate, currently unfinished application work.
- **Messages:** migration [`0020_reports.sql`](../supabase/migrations/0020_reports.sql)
  adds `messages_select_reported_moderator`, allowing staff to read the reported
  message, not adjacent messages solely because of that role. The policy still applies
  after the report is decided. Migration
  [`0023_authorization_hardening.sql`](../supabase/migrations/0023_authorization_hardening.sql)
  adds caller-scoped report-target eligibility; deployment and hosted negative tests
  must verify it before relying on the protection.
- **Profiles/content:** profile SELECT policies include moderator access to private
  profiles, and some domain policies give staff broader content access. Do not promise
  that private fields/drafts are always hidden from staff; review the owning policy
  and local adapter.
- **Roles/directory:** administrators can read all `user_roles` rows; moderators and
  administrators have directory-review capabilities. Role assignment is not an
  ordinary client write.

The moderation queue's local message scope is not the same as the separate
[`/admin/data`](../src/app/admin/data/page.tsx) inspector: that administrator-only
page previews local store arrays and row counts with selected secrets masked.
It is not a hosted data browser or a general private-content filtering guarantee.
Use synthetic data for screenshots; machine/file access remains a separate trust
boundary.

The **service-role key** bypasses RLS, and a privileged database operator/local file
owner has powers beyond an ordinary staff session. Keep those boundaries explicit;
see [ENVIRONMENT.md](ENVIRONMENT.md).

## Checking who holds a role

In the Supabase SQL editor:

```sql
select ur.role, ur.granted_at, p.username, p.display_name
from public.user_roles ur
join public.profiles p on p.id = ur.user_id
order by ur.role, ur.granted_at;
```

## Revoking a role

```sql
delete from public.user_roles where user_id = '<uuid>' and role = 'admin';
```

Run only as an authorized privileged database operator after checking the target
and role. A SQL-editor connection is not the same identity as an ordinary API staff
session; the role guards/grants refuse client role writes. This example is not
authorization to revoke an account's role.

## Implemented surfaces and remaining acceptance

| Surface | Source-confirmed scope / remaining |
| --- | --- |
| [`/admin`](../src/app/admin/page.tsx) | Staff-gated report queue and decision controls exist, not an empty route. |
| Content reports | UI/actions and `0020` exist for posts, comments, projects, ideas, messages and profiles. Opportunity/event report coverage is unfinished. |
| [`/admin/universities`](../src/app/admin/universities/page.tsx) | Pending directory requests and staff review exist. |
| [`/report-a-bug`](../src/app/report-a-bug/page.tsx), [`/admin/bug-reports`](../src/app/admin/bug-reports/page.tsx) | Submission/own reports and administrator-only triage exist, with local and hosted action paths. |
| [`/admin/audit`](../src/app/admin/audit/page.tsx) | Audit UI and database append-only guards exist. Local actions append store rows; the local file is not tamper-proof evidence. |
| Account sanctions | Warnings/timed suspension actions and SQL account states/restriction triggers exist; local session revocation/expiry has regression coverage. Do not infer a complete ban/unban or hosted session lifecycle. |
| Operational counts / data | Queue badges and local store row counts are computed from rows. They are not a measured analytics/observability dashboard; `0021` is the rate-limit migration, not an analytics reservation. |
| Role management UI | No grant/revoke interface. Bootstrap/SQL are privileged operator workflows, not normal staff writes. |

Each current admin page re-checks `getStaffRole()` or the narrower `getAdminRole()`
as appropriate; actions and hosted policies/RPCs must independently enforce their
audience. The hosted `src/proxy.ts` redirect is a convenience, not staff authorization.
Local access checks are separate from database RLS.

[`tests/db/moderation.test.ts`](../tests/db/moderation.test.ts) and
[`tests/integration/local-domain.test.ts`](../tests/integration/local-domain.test.ts)
cover specific permissions/decisions, not completed hosted staff operations. Staff
MFA, direct-API abuse budgets, board-report coverage, appeals and operator response
procedures remain [current gates](bulla/ISSUES.md).

## Operational notes

- **Account deletion is not a completed product workflow (S10).** An authorized Auth
  admin deletion can trigger cascades or `set null`, but does not by itself establish
  ownership transfer, retention, export, media cleanup or recovery. Define and verify
  those contracts before treating a manual deletion as account-lifecycle completion.
- **Local fixtures exist.** `src/lib/local/seed.ts` initializes development data.
  `package.json` has no `npm run seed` command; the absence of that command does not
  mean the application has no seeding code. CLI seed settings are separate from both
  the JSON adapter and hosted acceptance. Never generate or reset owner/hosted data
  as a documentation check.
