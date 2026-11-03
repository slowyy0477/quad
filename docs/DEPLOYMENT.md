# Deployment

**Bulla is not cleared for a public launch.** Use the current
[recovery/production plan](bulla/PLAN.md), [issue register](bulla/ISSUES.md) and
[recorded verification](bulla/STATUS.md). Compilation is not evidence that
hosted identity, authorization, resilience or 50,000-user capacity passed.
The steps below are an operator reference, not authorization to provision,
bill, migrate, push or deploy. Confirm the intended isolated staging target
and recovery plan before any external change.

---

## What you need

| Prerequisite | For | Acceptance |
| --- | --- | --- |
| Managed Supabase project | Postgres, Auth, authorized Realtime, future private storage | Check actual compute, limits, backups, region and measured workload; no tier is proven here |
| Chosen Node/Next host | Stateless app replicas and TLS | Agree resource/connection budgets, monitoring and rollback |
| Google OAuth provider, if desired | Optional sign-in | Verify approved callback/origins and real login; do not create keys from this guide alone |
| Controlled domain and email delivery | Production origin and transactional mail | Verify TLS, SMTP/confirmation/recovery and operational ownership |

The shipped integrations are not a complete operating service. Monitoring,
email delivery, safe uploads, jobs and recovery still need acceptance. Keep
draft privacy/terms accurate as providers and actual data practices change.

## 1. Database

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Verify the actual migration catalog and schema: every client-facing table has the RLS
shield lit. If any table shows RLS disabled, stop — that table is world-readable with
the public anon key. (`npm test` asserts this, so it should not happen; check anyway,
because this is the failure that matters most.)

Then, in **Project settings → Database**:

- Confirm actual backup/PITR entitlement, retention and the agreed recovery objectives.
- Before real users exist, restore one backup into a scratch project. An untested
  backup is not a backup.

## 2. Auth configuration

**Authentication → URL configuration:**

```
Site URL:       https://your-domain.example
Redirect URLs:  https://your-domain.example/auth/callback
                http://localhost:3000/auth/callback
```

**Authentication → Providers → Email:** confirm "Confirm email" is on. The sign-up flow
assumes it.

**Authentication → Providers → Google** (optional): paste the client ID and secret from
Google Cloud Console. In Google Cloud, the authorised redirect URI is Supabase's, not
yours:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

Request no scopes beyond the default profile ones.

## 3. Environment variables

Set these in your host's dashboard. Full reference: [ENVIRONMENT.md](ENVIRONMENT.md).

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_DATA_MODE=supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

`NEXT_PUBLIC_SITE_URL` is **required** in production: the OAuth callback URL is built
from it, and a wrong value sends a user and their authorization code to another origin.

The service-role key is optional for ordinary browsing and server-only wherever
an explicitly reviewed privileged feature needs it. Never expose it in a public
variable. Enable `BULLA_REQUIRE_HTTPS=1` only for the actual TLS deployment.
Do **not** set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the hosting environment. They are
read by a local script; see [ADMIN.md](ADMIN.md).

## 4. Deploy

Choose the deployment host only after staging and budget decisions. Follow its
current official deployment procedure; do not install global tooling or promote
a production deployment as an automatic consequence of this guide.

Local compilation/serving commands:

```bash
npm ci
npm run build
npm start
```

Node ≥ 20.9. The anon key is compiled into the client bundle at build time, so rotating
it requires a **rebuild**, not a restart.

## 5. First admin

Only for an explicitly approved target, from your machine with `.env.local`
pointing at that verified project:

```bash
npm run create-admin
```

Then delete the credentials from `.env.local`. See [ADMIN.md](ADMIN.md).

## 6. Verify the deployment

Local automated smoke exists, but hosted acceptance below is still required.
Record real outcomes rather than checking boxes merely because a page exists.

- [ ] `/` renders, and shows **no** "Setup required" badge
- [ ] `/setup` reports the expected provider/configuration; presence does not prove connectivity
- [ ] `/status` loads
- [ ] Sign up with a real address → the confirmation email arrives → the link returns to
      the site signed in
- [ ] Sign in, sign out, sign in again
- [ ] Password reset email arrives and works
- [ ] Google sign-in, if enabled
- [ ] Post to the feed; confirm the row exists in the Table editor with the right
      `author_id`
- [ ] Sign out and hit `/feed` → redirected to `/login`
- [ ] Open dev tools → Network → confirm no request carries the service-role key
- [ ] View source → search the bundle for the service key → **must not appear**

The last two are the ones to do properly.

---

## Production launch checklist

Unticked items are not ready. This is the honest state, not a wish list.

### Blocking — must be done before real users

- [ ] **Legal review.** `/terms` and `/privacy` are drafts and say so on the page. A
      lawyer must review them. Do not remove the warning banners to make the site look
      finished.
- [ ] **Remove `robots: { index: false }`** from `src/app/layout.tsx` — but only when the
      rest of this list is done. A half-built site in search results is harder to undo
      than to prevent.
- [ ] **Moderation.** Reports/decisions/audit exist, but database report eligibility,
      board coverage, staff authentication and real operational review must pass.
- [ ] **Rate limiting.** Limiter code exists; enforce server-owned direct-write
      budgets atomically, including independent concurrent and bypass tests.
- [ ] **A security contact.** [SECURITY.md](SECURITY.md) §9 has no address.
- [ ] **Backups verified by restore.**
- [ ] **Onboarding.** Screens/local persistence exist; complete hosted journeys
      and explicit initial publication choice.
- [ ] **Account lifecycle.** Recovery completion, reauthentication, export/deletion,
      ownership transfer and retention/media cleanup.
- [ ] **Capacity and recovery.** Measure the agreed realistic staging workload,
      connection/fan-out/query budgets, soak/spike/failure and actual restore.

### Important

- [ ] Runtime CSP/nonces, `src/proxy.ts`, secure cookies/origin checks and actual TLS headers
- [ ] Two-account and hosted Playwright/integration journeys beyond local smoke
- [ ] Permission/retry/concurrency coverage for all exposed domains and direct APIs
- [ ] Error reporting (Sentry or equivalent — none)
- [ ] Uptime monitoring
- [ ] Accessibility audit with a screen reader
- [ ] Lighthouse pass on mobile
- [ ] A custom domain, so the auth cookie is on a domain you control

### Before announcing

- [ ] Every feature marked `planned` or `schema-only` on `/status` is either built or
      still honestly labelled. **Do not remove the status page to look finished** — it is
      the thing that keeps the product honest with its users.
- [ ] No synthetic test/demo accounts or content in production. Local preview
      seeding and staging fixtures must not become real-user evidence.
- [ ] Confirm the "under construction" copy still matches reality.

## Rollback

Vercel keeps previous deployments; promote an earlier one from the dashboard.

Database migrations do **not** roll back. There is no down-migration in this project,
deliberately — a down-migration that has never been run is a false sense of safety. To
undo a schema change, write a new forward migration. Take a snapshot before
`db:push` on anything with real data in it.
