# Bulla — a campus community for people, work and learning

Bulla helps university students make a profile, find people and projects, share
their work, collaborate and keep a record of learning.

The app is unfinished, in private development, and **not cleared for public
launch**. The 50,000 registered-user figure is an engineering target, not measured
capacity, concurrent-user support or evidence of production readiness.

The active checkout remains `E:\Uni-Social-Network` intentionally. `E:\Bulla` is a
workspace entry point, not another app. Keep existing source, local data and
compatibility launchers in place; a public naming change does not rename their
paths or historical URLs.

## Current source of truth

Start with [AGENTS.md](AGENTS.md), [current status](docs/bulla/STATUS.md), the
[Bulla recovery plan](docs/bulla/PLAN.md) and the [issue register](docs/bulla/ISSUES.md).
The plan defines the remaining milestones, security gates and load-test contract.
It supersedes the [older plan](docs/plan/PLAN.md); the other `docs/plan/` files
remain historical or generated references, not the current completion schedule.

The [feature ledger](src/lib/build-status.ts), displayed at `/status`, records
implemented scope and known gaps. Most user-facing domains are marked `partial`,
not database-only. A ledger label is not a hosted acceptance result.

## What exists today

- Versioned PostgreSQL migrations, RLS, explicit function/column grants and
  embedded PostgreSQL permission tests.
- Screens and actions for accounts/onboarding, profiles/skills, campus browsing,
  follows/connections/blocking, feed posts/likes/comments/saves, projects and ideas.
- Messaging, notifications, goals/study logs, achievements, opportunities/events,
  search, reports/moderation, bug reporting and admin tools.
- Bulla identity, shared light/dark UI foundations, navigation, install icons,
  a PWA manifest and a public offline-help screen. This is not a completed
  all-screen redesign or an offline account/messaging app.

These implementations still need correctness, privacy, provider-parity and
browser acceptance work. Hosted Auth/OAuth/recovery and Realtime are not accepted
merely because their code exists. Local private-image uploads and account
lifecycle code have isolated test evidence; hosted image publication/cleanup,
protected deletion-worker rollout, measured capacity and hosted recovery remain
release gates. See
[PRODUCT.md](docs/PRODUCT.md) for a domain-by-domain summary.

## Install and run privately

Requirements: Node.js `24.x` (as declared in [package.json](package.json)) and
npm. The app uses Next.js 16, React 19, TypeScript and Tailwind 4.
The pinned Supabase SDK requires Node 22+. Bulla deliberately pins the tested
Node 24 major for local, CI and hosting: an open-ended engine range overrides
the Vercel project setting and can silently select a newer, untested major.
The private JSON adapter needs neither Supabase nor Docker.

From the existing checkout, in PowerShell:

```powershell
Set-Location 'E:\Uni-Social-Network'
npm ci
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
```

Edit `.env.local` without overwriting existing configuration or printing its
contents. For private local development select:

```dotenv
NEXT_PUBLIC_DATA_MODE=local
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
```

Keep an existing `LOCAL_DATA_PATH`; when unset, the adapter uses
`data/local.json` relative to the checkout. Do not relocate existing data or
the `D:\Quad` compatibility services as part of the rebrand. Local sample
content is development data, not real campus activity or adoption evidence.

```powershell
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open [Bulla locally](http://127.0.0.1:3000). Local accounts and content stay on
this computer. Local mode has no Supabase RLS, cloud Realtime, Google sign-in,
email verification or email recovery; its TypeScript access/session checks are
not a substitute for the hosted database boundary. Keep it loopback-bound and
never expose it as a public service.

Production serving in local mode is rejected unless an explicit private-review
override is set. That exception is only for a private, loopback-bound review,
not a deployment route. Restart the dev server after environment changes;
rebuild when changing public environment variables for a production build.

## Supabase mode — separate hosted acceptance required

The intended hosted backend is [Supabase](https://supabase.com): Auth,
PostgreSQL/RLS, authorized Realtime and, once implemented, private storage.
Choose a project and resource budget deliberately; no tier has been demonstrated
to meet Bulla's capacity target.

Configure `.env.local` for that mode using the project's public client settings:

```dotenv
NEXT_PUBLIC_DATA_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=<project-url-without-trailing-slash>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<project-public-anon-key>
NEXT_PUBLIC_SITE_URL=<this-app-origin>
```

Service-role credentials are server-only and are not required for ordinary
browsing. Never put them in a `NEXT_PUBLIC_*` variable, source control or a log.
`/setup` reports Supabase variable presence; it does not prove connectivity,
local-mode readiness or a successful hosted journey.

Only after confirming an authorized staging project, applied migration history
and the migration/backup plan:

```text
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

These commands link a project and apply database changes. Do not reset an
existing database or blindly reapply a full migration bundle. Configure allowed
origins and `/auth/callback`, email delivery, OAuth and the intended provider
password/verification/staff-MFA policies separately.

The recovery request currently redirects toward the missing
`/settings/password` completion route. A reset-request action is not a complete
password-reset journey. Hosted Auth, PostgREST/RLS, Realtime, storage and
two-account privacy tests remain gates in [ISSUES.md](docs/bulla/ISSUES.md).

## Available commands

These are defined in [package.json](package.json); their presence is not a record
that they passed. Do not run generators or hosted commands during a docs-only task.

| Command | Scope |
| --- | --- |
| `npm run dev` | Next.js development server; use the loopback arguments above for local mode |
| `npm run build` / `npm start` | Build and serve the selected backend; production local-mode guard still applies |
| `npm run typegen` / `npm run typecheck` | Generate route types; typecheck runs `next typegen` before `tsc --noEmit` |
| `npm run lint` | ESLint; `npm run lint:fix` also changes files |
| `npm test` | Vitest database-permission, local-action/security and unit/component suites |
| `npm run test:watch` / `npm run test:coverage` | Watch tests or produce coverage |
| `npm run verify` | Typecheck + lint + Vitest; does not include a production build or Playwright |
| `npm run verify:bulla` | Isolated recovery checks with a Markdown report after every step on the task drive; optional `--build --e2e` |
| `npm run test:e2e` / `npm run test:e2e:ui` | Playwright local smoke tests; requires a supported browser |
| `npm run db:types:local` | Generate `src/lib/db/database.types.ts` from migrations using PGlite, without hosted access or Docker |
| `npm run db:schema:local` | Generate `docs/plan/SCHEMA.md` and `docs/plan/schema.json`; these paths intentionally remain unchanged |
| `npm run db:types` | Generate types from the linked Supabase project; requires configured CLI/project access |
| `npm run db:check` | Probe the configured hosted database; not end-to-end acceptance |
| `npm run db:bundle` | Generate SQL from migration files; review the output and applied history before any use |
| `npm run db:push` | Apply migrations to a linked project; an external write requiring an approved target |

The [Playwright config](playwright.config.mts) restricts smoke tests to loopback
and creates isolated fixture/artifact paths under the D-drive recovery folder on
Windows. Do not reuse a server with personal data. For other recovery tests,
set `BULLA_TEST_TMP_DIR` under `D:\All tasks + Automations\Bulla-Recovery`.
Test logs, temporary fixtures, screenshots and checkpoints belong there, not in
another source checkout.

For repeatable recovery work, prefer `npm run verify:bulla`. It selects dedicated
D-drive fixtures/cache/build output and writes a unique `REPORT.md` after each
check. `npm run verify:bulla -- --build --e2e` also compiles and runs local browser
smoke; neither proves hosted security or capacity. Run one verifier at a time.

## Verification and release gates

Current evidence belongs in [STATUS.md](docs/bulla/STATUS.md), not in fixed test
counts copied into this README. The repository contains PGlite permission tests,
local integration/security tests, unit/component tests and Playwright smoke
specs. Embedded database tests do not exercise hosted Auth, PostgREST or Realtime;
local browser success does not establish hosted or multi-user correctness.

Before public launch, resolve the authorization, departed-message visibility,
DM-policy, direct-API abuse-budget and account-lifecycle gates; complete recovery,
uploads, board trust/reporting and staff operations; verify real two-account
journeys and the remaining design/accessibility/device states. Record hosted
staging, security, backup/restore and realistic load/soak/spike evidence against
the [capacity contract](docs/bulla/PLAN.md#6-capacity-test-contract).
Neither a clean dependency audit nor a build is a security or readiness sign-off.

## Repository and reference docs

`src/app/` contains App Router routes; `src/features/` holds domain schemas,
queries, actions and components; `src/lib/` holds provider adapters, shared
access/configuration helpers and the feature ledger. `supabase/migrations/`
is the forward SQL history. `tests/db/`, `tests/security/`, `tests/integration/`
and `tests/e2e/` cover different verification layers.

- [Product](docs/PRODUCT.md), [Bulla plan](docs/bulla/PLAN.md),
  [design contract](docs/bulla/DESIGN.md), [research](docs/bulla/RESEARCH.md) and
  [archive review](docs/bulla/ARCHIVE-REVIEW.md) describe the current direction.
- [Architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md),
  [auth](docs/AUTH.md), [security](docs/SECURITY.md), [testing](docs/TESTING.md),
  [environment](docs/ENVIRONMENT.md), [deployment](docs/DEPLOYMENT.md) and
  [admin](docs/ADMIN.md) are technical references that may retain older names,
  counts or implementation assumptions. Cross-check them against source and
  the Bulla records before following operational instructions.

Follow [AGENTS.md](AGENTS.md), preserve existing uncommitted work and verify
each implementation slice in proportion to its risk. Historical prototypes are
references, not replacements for this checkout.

## Licence

MIT — see [LICENSE](LICENSE).
