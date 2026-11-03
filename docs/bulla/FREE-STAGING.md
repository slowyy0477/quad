# Bulla — free staging setup and acceptance

Updated: 31 October 2026. This is a setup checklist, not a deployment approval.
Keep the owner's working local preview and accounts unchanged.

## What is available now

- Private local review: <http://127.0.0.1:3000>.
- Source: `E:\Uni-Social-Network`; task records and fixtures:
  `D:\All tasks + Automations\Bulla-Recovery`.
- Local staff account instructions: the task folder's `STAFF-ACCOUNTS.md`.
  Passwords are only in private local credential files, never in this document.
- Supabase integration was found but is not installed/connected. An existing
  suggestion is pending; no duplicate suggestion or hosted project was created.
- Browser acceptance uses the installed Playwright browser. Built-in control
  currently reports that its runtime is unavailable; the app panel was queued.

## What the owner needs to do

1. Open the [Supabase dashboard](https://supabase.com/dashboard), sign in and
   create or choose an **empty, isolated Free project** for Bulla staging.
   Connect the suggested Supabase integration if it is available in the app.
   Do not choose a project containing real users or another application's data.
2. Identify that staging project to the agent before migrations are applied.
   Keep keys in local, ignored configuration or the connector's protected setup,
   not in chat, screenshots, Markdown or Git. Do not replace the working
   preview's `.env.local`.
3. Use two email addresses you control for acceptance. Complete Google sign-in,
   email links and authenticator challenges yourself when the browser asks.
   No real account is deleted as part of a test.

No card, paid plan, purchased domain, email subscription or live deployment is
required for the local work completed so far. Stop before any setup requests
payment or access beyond the selected staging project.

## Staging configuration contract

Run a separate loopback preview, for example on port 3400, with a dedicated
D-drive build directory. Do not switch or reuse the owner's local datastore.
The existing application configuration requires:

| Setting | Staging purpose |
| --- | --- |
| `NEXT_PUBLIC_DATA_MODE=supabase` | Explicit hosted adapter |
| `NEXT_PUBLIC_SUPABASE_URL` | Selected project's HTTPS URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public publishable/anon client credential |
| `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3400` | Exact separate review origin |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only operations that require it; never a browser credential |
| `BULLA_ALLOW_LOCAL_IN_PRODUCTION` | Leave unset; not a way to deploy local JSON |

Before starting, inspect the actual configured project, apply the reviewed
forward migrations in order, and verify exposed schemas, grants and RLS.
The source migration directory—not a historical bundled SQL file—is current.
Do not reset, overwrite or auto-seed a nonempty hosted database.

Allow the exact Bulla callback and recovery paths for the selected staging
origin. Keep the site's origin and the provider's allowlist consistent; use
exact production HTTPS paths when deploying.
[Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).

For recovery, review the repository's `src/features/auth/recovery-email.html`
against `/auth/recovery` and `/settings/password`, then test a real delivered
link, expiry/replay rejection, password change and old-session rejection.
Do not treat a mocked email-request success as delivery.

Google requires owner-configured OAuth credentials and provider settings.
Use only basic identity scopes; do not request access to Gmail or Drive.
Verify both the provider callback and Bulla callback with real browser sessions.
[Supabase Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google).

The default Supabase mail service currently sends only to organization-team
addresses, is limited to two messages per hour, and is not production mail.
It can support limited owner-controlled setup tests; arbitrary student email
delivery needs an appropriate SMTP provider and its own verified configuration.
[Supabase SMTP restrictions](https://supabase.com/docs/guides/auth/auth-smtp).

## Required hosted acceptance

- Real signup, confirmation, login/logout, private defaults and two devices.
- OAuth and recovery callbacks, expiry/replay and revoked-session refusal.
- Direct REST/RPC negative authorization tests, including staff MFA expiry,
  factor removal, reports, blocks, project roles and departed-message history.
- Messages/notifications publication, authorized live delivery and reconnect.
- Private image access and deletion-worker retries. Hosted uploads stay disabled
  until exact-object cleanup is safe; never enable a public unrestricted bucket.
- Independent write races, query plans, measured load and a successful restore.

Record actual outcomes in `STATUS.md`, `COMPLETION.md` and the D-drive
`CHECKPOINT.md`. These checks are not completed merely by configuring a provider.

## The 50,000-user target

Supabase's Free plan lists a 50,000 monthly-active-auth-user allowance and a
500 MB database. Those are quotas, not evidence that Bulla's database, messages,
media, Realtime and backups support the proposed workload at no cost.
[Supabase pricing](https://supabase.com/pricing),
[database quota](https://supabase.com/docs/guides/platform/billing-on-supabase).

The current target means 50,000 **registered accounts**, not simultaneous
sessions. Follow `PLAN.md` for the workload, resource assumptions and acceptance.
No production capacity, availability or recovery guarantee has been recorded.
