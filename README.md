# Quad — a university student network

One profile for your studies, projects and collaborations, with the people from your
own university attached to it.

Quad is **under construction**. Large parts of it exist as a database with enforced
permissions and no interface yet. That is stated plainly inside the running
application: `/status` lists every feature and its real state, and any route whose
feature is unbuilt says so instead of showing a mock-up.

---

## What actually works today

| Layer | State |
| --- | --- |
| Database schema, RLS policies, triggers, functions | **Working.** 15 migrations, 52 tables, 132 `app.*` functions. Every table has policies. |
| Automated database permission tests | **Working.** 292 tests over 8 files, run against a real Postgres in-process. |
| Auth — sign up, sign in, sign out, password reset, Google OAuth | **Working**, once Supabase credentials exist. |
| Design system, app shell, landing/legal/status pages | **Working.** |
| Feed — write a post, read the feed | **Partly working.** Real reads and writes; no likes/comments controls, no ranking, no pagination UI. |
| Profiles, universities, connections, projects, ideas, messaging, goals, achievements, opportunities, events, notifications | **Database only.** Schema, policies and tests exist. No interface. |
| Moderation, reports, bug reports, admin, search, uploads, rate limiting, analytics | **Not built.** |

Nothing in this repository has been run against a live Supabase project yet — see
[Verification status](#verification-status).

## Requirements

- Node.js ≥ 20.9
- A [Supabase](https://supabase.com) project (free tier is enough)
- Optional: Docker, if you want a local Supabase stack. Without it, use a hosted
  project; the migrations are identical either way.

## Getting started

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` from **Project settings → API** in the Supabase dashboard, then
apply the schema:

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Then run it:

```bash
npm run dev
```

The app starts whether or not Supabase is configured. Without credentials every
data-backed feature is switched off and says so; `http://localhost:3000/setup`
reports exactly which variables are missing.

### Generate database types (recommended after any migration)

```bash
npm run db:types
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) on port 3000 |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` — typegen first, or `PageProps`/`LayoutProps` do not resolve |
| `npm run lint` | ESLint |
| `npm test` | Vitest, including the database permission suite |
| `npm run verify` | typecheck + lint + test |
| `npm run db:push` | Apply migrations to the linked project |
| `npm run db:types` | Regenerate `src/lib/db/database.types.ts` |

## How it is put together

```
supabase/migrations/   the schema: tables, RLS policies, functions, triggers
tests/db/              permission tests that run the real migrations in PGlite
src/app/               routes (App Router)
src/features/<domain>/ one folder per domain: schemas, queries, actions, components
src/components/ui/     design-system primitives
src/components/layout/ shell — header, footer, placeholders
src/lib/               env, Supabase clients, shared utilities
proxy.ts               session refresh + route gating (Next 16's middleware)
```

Module boundaries: `features/*` may import from `lib/*` and `components/*`, never
from another feature's internals. `components/ui/*` imports nothing from `features/*`.

Longer discussion in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The other documents:

| Document | Covers |
| --- | --- |
| [PRODUCT.md](docs/PRODUCT.md) | what Quad is for, and what it deliberately is not |
| [DATABASE.md](docs/DATABASE.md) | the 15 migrations, conventions, the `app` schema |
| [AUTH.md](docs/AUTH.md) | the four auth flows, the proxy, the cookie dance |
| [SECURITY.md](docs/SECURITY.md) | threat model, the four authorization layers, what is not protected yet |
| [TESTING.md](docs/TESTING.md) | what the 292 tests assert — and what has no tests |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md) | every variable, who may see it, what breaks |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | deploy steps and the production launch checklist |
| [ADMIN.md](docs/ADMIN.md) | creating the first admin; what admins cannot see |

## Security posture in one paragraph

Authorization lives in Postgres, not in the interface. Every one of the 52 tables has
row-level security enabled with explicit policies, and table-level grants are revoked
from `anon` and `authenticated` and re-granted column by column, so a column a client
must not write (`moderation_status`, `like_count`, `status`) is not merely hidden — it
is not grantable. Every database function is granted to exactly the roles that need
it, and a test fails if a new function is added without that decision being made.
Hiding a button is never treated as a permission. The full reasoning — threat model,
the four layers, the traps that cost real debugging time, and an explicit list of what
is **not** protected yet — is in [docs/SECURITY.md](docs/SECURITY.md).

## Verification status

Be clear about what has and has not been checked:

- **Verified:** the database layer. `npm test` runs all 15 migrations against
  PostgreSQL 18 (PGlite) and asserts, per role, what each kind of user can read and
  write. 292 tests pass.
- **Verified:** the app compiles, typechecks, lints, and every route returns the
  status it should — checked in a browser against the dev server.
- **Not verified:** anything requiring a live Supabase project. No Supabase
  credentials have been supplied to this repository, so sign-up, sign-in, Google
  OAuth, the profile-creation trigger firing on a real `auth.users` insert, and
  reading and writing posts have **not** been exercised end to end against hosted
  Postgres. The code is written to work; it has not been run.
- **Not written:** Playwright end-to-end specs. Playwright is installed; there are no
  specs yet.

## Contributing

Small, logical commits with conventional-commit messages. Run `npm run verify` before
pushing. If you add a database function, expect `tests/db/schema.test.ts` to fail
until you record which audience it is for — that failure is the feature.

## Licence

Not yet chosen.
