# Engineering plan

How the code is built, verified and released from here on: the standards, the gates, the CI
that enforces them, and the review discipline. Written for a **solo maintainer** — every
process here exists to substitute for a second pair of eyes, so anything that only works with
a team is left out.

Read alongside [PLAN.md](PLAN.md) (order of work) and [UX.md](UX.md) (interface contract).

---

## 1. What is already strong — do not lose it

Verified on 14 Oct 2026, and worth stating plainly because the plan's job is to protect
these while adding features:

| Strength | Evidence |
| --- | --- |
| Authorisation is in the database, not the interface | 52 tables, **52 RLS enables, 182 policies**, column-level `GRANT`s |
| Function privileges are decided, not defaulted | 132 `app.*` functions; a test fails when a new one has no declared audience |
| Migrations are proved by running them | 296 tests apply the real SQL to PostgreSQL 18 (PGlite) |
| The security posture is documented | [SECURITY.md](../SECURITY.md), threat model + four layers + what is *not* protected |
| Decisions are recorded where they can be found | Long header comments in the migrations themselves |
| Honesty is a mechanism, not a promise | `build-status.ts` is code and `/status` renders it |
| Architecture is restrained | no Redis, no queue, no microservices, `revalidatePath` chosen over tags *with the reason written down* |

Three of these — invariant tests, column-level grants, the status page — are things most
professional codebases do not have. The plan builds on them.

---

## 2. Engineering findings

### E1 — No CI means no verification that survives a bad week (F5)

`npm run verify` (typecheck → lint → 296 tests) passes and takes **549 s** on this laptop.
That is a fine thing for a human to run voluntarily and it will still get skipped. There is no
`.github/` at all: no workflow, no PR template, no issue templates.

### E2 — The app layer is untyped against its own schema (F6)

`src/lib/db/database.types.ts` **does not exist**, so 462 lines of `queries.ts` hand-declare
row shapes against 52 tables. TypeScript cannot catch a rename, a nullability change, or a
column that no longer exists. Generate it, commit it, derive from it, and add a CI check that
fails when it is stale.

### E3 — The test pyramid is one floor (F9)

296 database tests; **0** component, Server Action, Zod or end-to-end tests. `tests/e2e/`,
`tests/integration/`, `tests/security/` are empty directories. The database deserves its
coverage — it is the security floor — but today a broken button and a broken policy are equally
invisible, and the "296 tests" headline is one quarter of a test strategy wearing all of it.

### E4 — Module boundaries are conventions, not rules

ARCHITECTURE §3 lists four import rules and says they are "not yet mechanically enforced";
they are followed by hand. Hand-followed rules decay the moment a feature is built in a hurry,
which is exactly what M3–M6 are.

### E5 — The migration numbering the docs promise does not exist

`PRODUCT.md` and `DEPLOYMENT.md` name `0016_moderation`, `0017_rate_limits`, `0018_search`,
`0020_storage`. The tree has `0016_backfill_profiles` and `0017_university_reference_data`.
Next free number is **0018**, and from here a number is reserved in the issue that will write
it. Renumbering applied migrations is not allowed.

### E6 — No ERROR/observability path

No error reporting, no uptime check, no CSP or security headers (`next.config.ts` is 7 lines),
no `sitemap.ts`/`robots.ts`. `robots: { index: false }` is set in `layout.tsx` and must stay
until launch — removing it early is the one mistake DEPLOYMENT.md warns about.

---

## 3. Code standards

Inherited from ARCHITECTURE.md and enforceable. Add one line to `eslint.config.mjs` per rule
the first time it is broken — do not write a style guide nobody runs.

**TypeScript**

- `strict` stays on. No `any` in committed code; `unknown` + a Zod parse at the boundary.
- Return types on exported functions in `queries.ts` and `actions.ts`.
- Row types come from `database.types.ts`, view models are declared per domain and returned by
  queries — never a raw row reaching a component.
- `import type` for type-only imports (`verbatimModuleSyntax`-clean).

**Boundaries (E4, to be enforced by `no-restricted-imports`)**

1. `components/ui/**` imports nothing from `features/**` or `lib/supabase/**`.
2. `features/a/**` may not import `features/b/**` internals; cross-domain reads go through the
   owning feature's exported queries.
3. `app/**` imports `queries.ts` / `actions.ts`, never internals.
4. Only `lib/supabase/admin.ts` touches the service-role key. Nothing else, ever.

**Server / client**

- Server Components read. A client component needs a reason in the PR body (state, event,
  browser API) or it does not ship.
- Every mutation is a Server Action with the shape in ARCHITECTURE §4: parse → auth → account
  status → rate limit → ownership guard → write → revalidate. Implement the wrapper in M7;
  until then, each action does the first three by hand *and says so in a comment*.
- Postgres error codes are mapped (`42501` → "You are not allowed to do that"), and the raw
  message never reaches the browser.

**Data**

- Cursor pagination `(created_at, id)` for anything unbounded. Offsets only in admin tables.
- Counters are trigger-maintained columns; `count(*)` never appears in a list view.
- A query returns what the screen needs in one round trip; N+1 in `queries.ts` is a bug.
- No number reaches the DOM that is not a stored value (PRODUCT.md rule 1).

**Migrations**

- Numbered, ordered, immutable once applied. No down-migrations — a new forward migration is
  how you undo.
- Header comment states the decisions and the rejected alternative, in the style of 0001–0017.
- Every new table: RLS enabled + a policy, grants decided column by column, and a permission
  test in `tests/db/` in the three-direction shape (owner can, stranger cannot, stranger cannot
  by ID substitution).
- Regenerate `supabase/apply-all.sql` (`npm run db:bundle`) in the same commit.

---

## 4. Definition of Done

Repeated from PLAN.md §7 because this is the checklist a PR is judged against.

- [ ] Permission test for every table touched; three-direction shape.
- [ ] Route ships four states (loading, error, empty, content).
- [ ] Every number is a stored value; every control works or is not rendered.
- [ ] `build-status.ts` updated in the same commit; `/status` re-read.
- [ ] `npm run verify` green locally **and** in CI.
- [ ] Works at 360 px, keyboard only, focus visible, errors announced.
- [ ] Commit message says what and why; PR body says what was verified and how.

---

## 5. CI pipeline

`.github/workflows/ci.yml` — three jobs, one required check on `main`.

| Job | Runs | Budget |
| --- | --- | --- |
| `verify` | `npm run typecheck`, `npm run lint`, `npm test` (296 db tests, ~150 s) | < 6 min |
| `build` | `npm run build` — catches what typecheck cannot | < 5 min |
| `e2e` (from M1) | Playwright against the linked Supabase project, secrets from GitHub Actions secrets | < 8 min |

Rules:

- `concurrency` cancels superseded runs — a slow laptop pushing five commits should not queue five
  pipelines.
- `npm ci` with the npm cache; Node pinned to 24 to match the local machine.
- **CI must never need the service-role key to pass.** The db suite runs in PGlite offline; only
  `e2e` holds secrets, and it uses a dedicated test project, not production.
- A `db:check` job on `main` only, alerting when the deployed schema drifts from the migrations.
- Branch protection on `main`: required `verify` + `build`, no force-push, squash merge only,
  linear history.
- Dependabot weekly, grouped, with the rule that a failing update is closed rather than merged
  blind. A 52-table schema on an unpatched Postgres client is not a place to be casual.

---

## 6. Test strategy

| Layer | Tool | What belongs there | Target by M5 |
| --- | --- | --- | --- |
| Database permissions | Vitest + PGlite | Every table's policies, three-direction; invariant tests for new tables/functions | 400+ |
| Domain logic | Vitest | Zod schemas, `safeRedirect`, cursor encode/decode, streak maths, ranking SQL | 40+ |
| Components | Testing Library | Only components with logic: composer, pagination, form error display | 15+ |
| End-to-end | Playwright | The flows that must not break: sign up/confirm/in, post, like, join project, message, report, gated-route redirect, admin refusal | 20–25 |
| Accessibility | axe in Playwright | Serious/critical violations on the ten busiest routes, zero tolerated | 10 routes |
| Visual | — | Not automated. Manual at milestone close; Playwright screenshots kept per milestone for comparison | — |

Discipline: a bug fix starts with a failing test. A new route without an empty state is not
done. The database suite is deliberately slow (~150 s) and stays that way — sharing state
between tests to save a minute would make failures order-dependent.

---

## 7. Dependency and secret hygiene

- `sonner`, `react-hook-form`, `@hookform/resolvers` and 13 Radix packages are installed and
  unused. **Use them or remove them in M2** — an unused dependency is a supply-chain liability
  with no upside. (Keep `react-hook-form` and `sonner`: M2's forms and toasts use them.)
- `.env.local` is git-ignored and contains a **real secret key plus an admin password**. It
  never leaves this machine: not into a chat, not into an issue, not into a screenshot.
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` are deleted after `npm run create-admin` (ADMIN.md says so;
  they are still present today).
- Rotate the secret key if it is ever pasted anywhere — it bypasses RLS completely.
- Before any public deploy: `git grep` for key prefixes and confirm nothing matches; confirm
  the service key is absent from `.next/static`.

---

## 8. Observability and operations (M7/M8)

| Need | Choice | Why |
| --- | --- | --- |
| Error reporting | Sentry free tier, or an `error_events` table + digest | A silent 500 on a phone is currently invisible |
| Uptime | UptimeRobot free, HTTP check on `/status` | Tells him the site is down before a user does |
| Logs | Supabase logs + Vercel function logs | No extra service |
| Backups | Supabase daily (paid) — or a weekly `pg_dump` to a private repo | Free tier has none, and an untested backup is decoration |
| Metrics that matter | signups, posts/day, week-2 return rate, verify time, test count by layer | Four numbers, reviewable in a minute |

---

## 9. Release process

```
issue #N  →  branch feat/N-slug  →  commits (conventional)  →  PR (template)  →  CI green
          →  preview deploy  →  click the changed routes once  →  squash-merge to main
          →  production deploy  →  close the issue  →  update build-status.ts if needed
```

- Tags `v0.1.0` at each finish line, with release notes written from the closed issues — free
  changelog, and a recruiter can read the history.
- Database changes deploy **before** code that depends on them, and the migration is pushed
  manually (there is no automatic migration step, deliberately, on a project with real data).
- Preview deploy at every milestone close, production at each finish line.

---

## 10. Engineering review checklist (self-review, before pushing)

1. Does `build-status.ts` still tell the truth about what I just did?
2. Is there a permission test for every table this touches — including the ID-substitution case?
3. Are all four states present on new routes?
4. Any number on screen that is not from stored rows? Remove it.
5. Any control that does nothing? Remove it or use `PlannedFeature`.
6. Does anything outside `lib/supabase/admin.ts` read a service-role key?
7. Did I import across a feature boundary, or into `components/ui` from a feature?
8. Is a raw Postgres error or `error.message` reaching the browser anywhere?
9. Does it work at 360 px and with the keyboard only?
10. Is the commit message's "why" present, or only the "what"?
11. Is a new dependency justified in the PR body, and is an unused one deleted?
12. Would I be able to explain this diff out loud, without the code in front of me, in a
    job interview? If not, do not commit it yet — read it until you can.
