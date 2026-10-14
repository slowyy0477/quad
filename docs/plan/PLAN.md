# Plan — completing Quad

**Written:** 14 October 2026, from a full read of the repository and measurements run on
this machine (every number below came from a command, not from a document).
**Scope:** what is actually finished, what is not, in what order to finish it, and what
"finished" is allowed to mean at each point.

This document supersedes the counts in [README.md](../../README.md) and
[docs/PRODUCT.md](../PRODUCT.md) where they disagree — both were written before the last
two weeks of work and have drifted (§2, F4).

---

## 1. Where the project actually stands

Measured on 14 Oct 2026 against the working tree of `E:\Uni-Social-Network`.

| Measurement | Value | Command |
| --- | --- | --- |
| Commits on `main` | 24 | `git log --oneline \| wc -l` |
| Files tracked | 116 | `git ls-files \| wc -l` |
| Uncommitted work | 2 files modified, 12 files untracked, **1,833 new lines** | `git status --short` |
| Migrations | 17 | `ls supabase/migrations` |
| Tables | 52, every one with RLS enabled | `grep -c 'enable row level security'` → 52 |
| RLS policies | 182 | `grep -c 'create policy'` |
| `app.*` database functions | 132 | `grep -c 'create function app\.'` |
| Database permission tests | **296, all passing** | `npm test` |
| Typecheck + lint | **clean** | `npm run typecheck`, `npm run lint` |
| `npm run verify` | **passes in 549 s** on this laptop | `npm run verify` |
| Component / action / Zod tests | 0 | — |
| Playwright specs | 0 (`tests/e2e/` empty) | — |
| Routes | 31, of which **10 are 8-line placeholders** | `wc -l src/app/**/page.tsx` |
| `loading.tsx` files | **0** — the four-state contract in ARCHITECTURE §9 is unmet | — |
| `src/lib/db/database.types.ts` | **does not exist** (`npm run db:types` never run) | — |
| Radix packages installed / imported | 15 / 2 — **13 unused** | `grep -rho '@radix-ui/react-[a-z-]*' src` |
| Unused installed deps | `sonner`, `react-hook-form`, `@hookform/resolvers` | — |
| `.github/` | absent — no CI, no templates | — |
| `LICENSE` | absent | — |
| Live Supabase project | **does not resolve** — `getaddrinfo ENOTFOUND` | `npm run db:check` |

### Route map (live, dev server on :3100)

```
/  /about  /login  /signup  /privacy  /terms  /guidelines  /status  /setup
/feed  /me  /me/edit  /u/[username]  /onboarding  /reset-password
/events /goals /ideas /messages /notifications /opportunities /projects
/report-a-bug /search /universities          ← all 8-line "PlannedFeature" stubs
```

The 25 tracked features in [`src/lib/build-status.ts`](../../src/lib/build-status.ts) are
still the right index of the product — they are just no longer accurate (§2, F3).

---

## 2. Findings

Each one has evidence and a fix. Ordered by what blocks what.

### F1 — There is no live database. Every "not verified" label is downstream of this.

`.env.local` holds a URL, a publishable key and a secret key for project
`sctvuolmcvwakjhcflla`, but that hostname does not resolve:

```
Project:  sctvuolmcvwakjhcflla.supabase.co
Expected: 52 tables from supabase/migrations
[TypeError: fetch failed] { cause: Error: getaddrinfo ENOTFOUND sctvuolmcvwakjhcflla.supabase.co }
```

General connectivity is fine (`supabase.com` → 200, `github.com` → resolves), so the
project was deleted, paused into deletion, or the ref was never real. Consequence: sign-up,
sign-in, Google OAuth, the profile-creation trigger, and reading/writing posts have **never
run against a real backend**, and won't until a project exists again.

**Fix (30 minutes, and it is step 1 of M1):** create a fresh Supabase project, replace the
three values in `.env.local`, `npm run db:push`, `npm run db:check`. The keys already in
`.env.local` are the new `sb_publishable_…` / `sb_secret_…` format, so the code path is
already the current one.

### F2 — 1,833 lines of finished work exist only on this disk, uncommitted, in a repo with no remote.

`src/features/profiles/` (601 lines), `src/features/projects/` (442), `src/app/u/[username]/`,
`src/app/me/edit/`, migration `0017_university_reference_data.sql`, and rewrites of
`/me` and `/onboarding`. All of it typechecks, lints and passes the suite — it is not a
sketch. It has no commit, no branch, no remote, and no backup. A disk failure loses the
most recent and most visible work in the project.

**Fix:** M0 — commit it properly, then push to a GitHub remote the same day.

### F3 — The honesty mechanism now lies, in the safe direction.

`build-status.ts` says onboarding is `planned` ("the interface is not built, so new accounts
keep their generated handle") and profiles, universities and projects are `schema-only`
("no interface"). The working tree contains all four interfaces. `PRODUCT.md` rule 2 and the
`/status` page promise that a feature is never described inaccurately; under-reporting is
still reporting inaccurately, and it makes the one page that keeps this project honest the
one page that is wrong.

**Fix:** M0 — update `build-status.ts` in the same commit as the features, and add a test
that fails if a route group gains a real implementation while its status entry still says
`schema-only`.

### F4 — The documentation drifted from the code in four places.

| Document says | Reality |
| --- | --- |
| README: "15 migrations", "16 migrations" (twice, differently) | 17 |
| README/dep docs: "no Supabase credentials have been supplied" | credentials were supplied; the project behind them is dead (F1) |
| `PRODUCT.md` / `DEPLOYMENT.md`: moderation = `0016_moderation`, rate limits = `0017_rate_limits`, search = `0018_search`, storage = `0020_storage` | `0016` = profile backfill, `0017` = university reference data. **The next free number is 0018** |
| `TESTING.md`: "296 tests, 8 files" | still true — the only document that survived |

**Fix:** M0 — mechanical corrections, and from then on the migration number is reserved in
the issue that writes it, so numbering cannot be guessed twice.

### F5 — No CI. Nothing verifies a push except a human who remembers to.

`npm run verify` exists and passes, and takes 549 s on this machine. That is exactly the
kind of thing that gets skipped. There is no `.github/` at all.

**Fix:** M0 — a workflow that runs typecheck, lint and the database suite on every push and
PR, and a branch protection rule on `main` that requires it.

### F6 — The application layer is hand-typed against a 52-table schema.

`src/lib/db/database.types.ts` does not exist, so every `queries.ts` writes its own row
shapes. With 52 tables and 132 functions, a schema change and a query can disagree and
TypeScript will not notice — the class of bug that reaches production and shows a blank page.
This is the single largest correctness risk in the app layer.

**Fix:** M1 — `npm run db:types` against the new project, commit the generated file, and make
`queries.ts` derive its return types from it.

### F7 — The route state contract is not implemented.

ARCHITECTURE §9 requires every data route to ship four states: loading, error, empty,
content; and says "a route with no empty state is not done". There is one `error.tsx` at the
root, **zero `loading.tsx` files**, and no shared `EmptyState` or `Skeleton` component. On a
phone on campus wifi, every route currently shows a blank screen while it waits.

**Fix:** pull it forward into M0/M2 as a component pair plus per-route files — it is small,
it is mechanical, and every later feature inherits it.

### F8 — The design system is 20% built and the rest is already paid for.

Nine primitives exist (button, input, field, alert, badge, avatar, surface, submit-button,
logo). Thirteen Radix packages — dialog, dropdown-menu, popover, select, tabs, tooltip,
switch, checkbox, radio-group, scroll-area, separator, label, visually-hidden — are
installed and never imported. Every feature milestone below needs several of them, so the
first move in each is finishing the primitive rather than inventing one.

**Fix:** M2 — a "UI kit completion" pass, listed in [UX.md](UX.md) §3, done once instead of
five times.

### F9 — The test pyramid is an inverted T.

296 database permission tests, 0 component tests, 0 Server Action tests, 0 Zod tests, 0
end-to-end specs. The database layer is the security floor and deserves its coverage, but
right now a broken button and a broken policy are equally invisible to CI, and the
poster-board claim "296 tests" hides that it covers one of four layers.

**Fix:** M1 starts the e2e suite with the five flows that matter (sign in, sign up, post,
gate a private route, sign out); M2 onward adds one permission test per table touched, and
component tests only for the components with logic in them.

### F10 — No licence.

README says "Not yet chosen". A public repo without one is legally all-rights-reserved,
which deters the contributors and the recruiter-read both goals depend on. MIT or
AGPL-3.0 depending on whether the intent is "look at this" or "no one may close it".
Recommend **MIT** for a portfolio artifact.

### F11 — The two launch blockers are still unbuilt and still blockers.

Moderation (no way to report content, no queue, no audit log) and rate limiting (nothing
limits how fast a user posts). Unchanged from DEPLOYMENT.md, and still correct: do not put
strangers on this platform without them. They are M7, deliberately after the features, but
they are on the critical path to finish line B, not optional polish.

### F12 — The strategic risk is product, not engineering.

This is the honest one. The engineering here is better than most student projects by a wide
margin: enforced authorisation in the database, an honesty contract, invariant tests,
documented decisions. What it does not have is a single user. A university network has a
cold-start problem — it is worthless with 10 accounts and useful with 80 — and 25 features
do not solve that; one campus do. Also worth naming: a large share of this codebase was
built with AI assistance, which raises the standard for *understanding* it, not lowers it.
Every milestone below ends in something he can explain out loud without the code in front
of him, which is the same thing as being able to defend it in an interview.

**Fix:** finish line A, then run the pilot at COMSATS Attock with his own batch (§3).

---

## 3. Scope triage — three places to stop

"Do not finish it" is not on the menu; "finish it" is 200 hours and four to six months. These
are the three honest stopping points, in order. Each is a complete, defensible state.

### Finish line A — **Defensible** (~5 weeks, 15 sessions)

The project is verified running end to end against a live database, every claim on `/status`
is true, CI is green, and the repo is public with a licence and a README that a stranger can
follow. Feed, profiles, onboarding and auth work with real accounts. Everything else is
honestly labelled "not built".

*Why this first: it converts 90% of the existing engineering into a verifiable portfolio
artifact, and it removes every lie from the repo. A recruiter or a supervisor can click it.*

### Finish line B — **Campus pilot** (~14 weeks, 45 sessions)

Finish line A plus: people (universities, connections, skills), a feed worth returning to
(likes, comments, pagination, ranking), projects and collaboration (the genuinely
differentiated feature — this is the reason to exist), and the safety floor (moderation + rate
limits) so 50 real students from his batch can be let in. Messaging and notifications follow
because a network without them is a noticeboard. Learning trackers, opportunities, events and
search stay labelled "not built" and ship after.

*Why this: it is the smallest version with a reason to exist, and the first version with a
measurable question attached — do 50 students come back in week two?*

### Finish line C — **As designed** (~22 weeks, 67 sessions)

All 25 tracked features built, which is roughly what PRODUCT.md describes: learning
trackers, goals, achievements, opportunities, events, search, moderation console, uploads,
email delivery. Worth doing only if B produced users who asked for these specific things.
Building them before that is guessing at what people want with 200 hours.

**Recommendation:** A now, B if the pilot at A shows anyone cares, C only when a real user
asks for a specific item on it. See [ROADMAP section in §4](#4-milestones).

---

## 4. Milestones

Sizes are in **sessions of about 3 hours** at 10–15 h/week, AI-assisted. Each milestone ends
at a state that can be demonstrated and has a test that proves it. `AC` = acceptance
criteria, all of which are checkable by running a command or clicking a route.

### M0 — Freeze and make honest · 3 sessions · blockers: none

| # | Deliverable |
| --- | --- |
| 0.1 | Commit the in-flight profiles/projects work in logical commits (conventional messages), migration `0017` included |
| 0.2 | `build-status.ts` updated for onboarding, profiles, universities, projects; `/status` re-read |
| 0.3 | Documentation drift fixed (F4): migration counts, credential claim, migration numbering reserved from 0018 |
| 0.4 | `.github/` added: CI workflow (`verify`), PR template, issue templates, `CODEOWNERS`-lite |
| 0.5 | `LICENSE` (MIT), `CONTRIBUTING.md` pointing at `npm run verify` |
| 0.6 | Public GitHub repo `quad` created, pushed, `main` protected |

**AC:** `git status` clean · `npm run verify` green in CI · `/status` count matches reality ·
repo reachable at a URL · no secret in the pushed tree (`git grep` for key prefixes finds none).

### M1 — Prove it against a live database · 4 sessions · blockers: M0

| # | Deliverable |
| --- | --- |
| 1.1 | New Supabase project, migrations pushed, `npm run db:check` all green |
| 1.2 | `src/lib/db/database.types.ts` generated and committed; `queries.ts` typed from it |
| 1.3 | The 11-step manual deployment check run once and its results written down |
| 1.4 | First admin created; `/admin` gate confirmed to refuse a non-admin |
| 1.5 | Playwright specs: sign up → confirm → sign in → post → sign out → gated route redirects |
| 1.6 | `npm run test:e2e` in CI, headless, against the live project |

**AC:** every row of DEPLOYMENT.md §6 ticked with a screenshot or a log line · a post created
in the browser exists in the Table editor with the right `author_id` · the service-role key
appears nowhere in the built bundle · e2e suite passes from a cold clone.

### M2 — Identity and people · 8 sessions · blockers: M1

Onboarding (built, needs verifying), public profile `/u/[username]` (built), profile edit
(built), universities browse + "I study here", skills and interests with the self-declared
label, connections/follow/blocks, avatar (initials only until M7 storage).
Plus **UI kit completion** (UX.md §3) and the loading/empty/error pair (F7).

**AC:** two real accounts can find each other, connect, and see each other's profile with
real data · a blocked user cannot see or be seen · permission tests exist for `profiles`,
`universities`, `social_graph`, `skills`, `interests` (the 4 tables TESTING.md names as the
largest gap) · every new route returns 200 with content, empty, loading and error states.

### M3 — A feed worth returning to · 8 sessions · blockers: M2

Likes, comments and saves with real controls; cursor pagination; following-only filter;
ranking as a documented SQL function; post detail route; the composer's "attach to a project
or goal" affordance (this is the differentiator in PRODUCT.md — the feed is a byproduct of
work); report-a-post is stubbed to M7's moderation table, not faked.

**AC:** like/comment counts match the rows · 50 posts paginate without duplicates or gaps ·
the ranking function has a test asserting its order for a fixed fixture · no count anywhere
is rendered that is not derived from stored rows.

### M4 — Projects and collaboration · 10 sessions · blockers: M3

Projects list/detail/create, membership and roles, join requests, "seeking members" with
required skills and slots, ideas vault and idea→project conversion, project updates with the
optional cross-post. Public project page at `/project/[slug]` (indexable — the one genuinely
shareable surface).

**AC:** a project can be created by one account, joined by a second, and its member list
reflects real rows · a non-member cannot read a private project, including by ID
substitution · idea→project conversion carries interested people across and a test asserts it.

### M5 — Talking to people · 8 sessions · blockers: M2

Messages: conversation list, thread, composer, unread counts. Notifications: bell, list,
mark-as-read, unread badge in the header. Realtime subscription for both, with RLS proved to
apply to the socket (a subscription may not leak rows the user cannot already read).

**AC:** two browsers, two accounts, a message arrives without a refresh · a third account
subscribes to the same channel and receives nothing · notification counts match unread rows.

### M6 — Learning and discovery · 10 sessions · blockers: M3

Semesters, courses, goals, daily log and the streak calculation; achievements displayed as
awarded by triggers; opportunities and events boards with applications and RSVPs; search —
migration `0018_search` (trigram usage, ranking, `/search` results page).

**AC:** the streak is computed from `daily_logs` and a test pins the boundary cases (DST,
missed day, two in one day) · an achievement appears only after the event that earns it ·
search returns a project, a person and a post from one query.

### M7 — Safety and operations · 10 sessions · blockers: M4, M5

Moderation migration: reports, moderator queue, actions, audit log, admin pages. Rate
limiting: Postgres fixed-window limiter plus the Server Action wrapper described in
ARCHITECTURE §4 (auth → account status → rate limit → guard → service). Storage buckets for
avatars and project images with MIME and size validation and ownership policies. CSP and
security headers. Error reporting and uptime monitoring. `sitemap.ts`, `robots.ts`.

**AC:** a reported post reaches the queue and the action appears in the audit log · a script
posting 100 times in a minute is refused on the 11th with a message, not a 500 · an uploaded
file is rejected if it is not an image or is over the limit · `npm run verify` plus a
security-headers test pass.

### M8 — Launch readiness · 6 sessions · blockers: M7

Accessibility audit (axe plus a real screen reader pass on feed, profile, messages, composer),
Lighthouse budget on a mid-range mobile profile, legal review of `/terms` and `/privacy`,
a backup restore drilled into a scratch project, a custom domain, `robots: { index: false }`
removed, and the "under construction" copy rewritten to match what is true on the day.

**AC:** every item above has a number attached, not an adjective · a restore from backup
produced a working database · the launch checklist in DEPLOYMENT.md is fully ticked or the
unticked items are named in the README.

**Total to finish line C: 67 sessions ≈ 200 hours ≈ 14 weeks at 15 h/week, ~22 weeks at a
realistic 9 h/week with exams.** Finish line A is M0–M1 plus the M2 UI-kit pass: 15 sessions.

---

## 5. Ordering rules

1. **Nothing new is built on an unverified layer.** M1 before any feature. A feature built
   on a database nobody has run is a guess with a nicer interface.
2. **One milestone in flight.** Parallel tracks are for the third of the week that isn't the
   current milestone; a half-finished M4 and a half-finished M5 is a project with no
   demonstrable state.
3. **Every feature commit carries its status-page change and its test.** Otherwise F3 repeats
   itself at the next milestone.
4. **The database-first order is already right and stays.** Schema, policies, permission
   tests, then interface — the reverse order is how a "social network" ends up with an
   interface over a hole.
5. **Ships in slices.** Each milestone deploys to the preview URL the day it closes, so
   "the site is broken" is discovered in a milestone, not at launch.

---

## 6. Working cadence

| When | What |
| --- | --- |
| Start of session | Pick the top issue in the milestone column of the board. Nothing else. |
| During | Branch `feat/…`, small commits, `npm run verify` before pushing |
| End of session | Push, open a PR, let CI answer. If CI is red, that is tomorrow's first issue. |
| Weekly | 20-minute review (see [GITHUB.md](GITHUB.md) §6): what closed, what moved, what is blocked, and re-read `/status` against reality |
| Milestone close | Deploy, demo to one person who is not him, write the honest state into README |

---

## 7. Definition of Done

A task is done when all seven are true. This is the checklist in
[ENGINEERING.md](ENGINEERING.md) §4, repeated here because it is what the plan is graded on.

1. Schema, policies and a **permission test** exist for any table touched — the
   three-direction shape (owner can, stranger cannot, stranger cannot by ID substitution).
2. Route ships **four states**: loading, error, empty, content.
3. Every number rendered is a **query over stored rows**; every control does something or is
   not rendered (PRODUCT.md honesty rules 1 and 2).
4. **`build-status.ts` updated** in the same commit, and `/status` re-read.
5. **`npm run verify` green** locally and in CI.
6. Works at **360 px** and with keyboard only; focus visible; form errors announced.
7. The commit message says **what** and **why**, and the PR body says what was verified and how.

---

## 8. Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Disk loss of uncommitted work (F2) | medium | **severe** | M0.1 — commit and push today |
| Scope creep: 25 features, one person, semester exams | **high** | high | Finish line A first; one milestone in flight; C only on user demand |
| Cold start: no users, so no feedback, so guessing at features | high | high | Pilot at his own campus at finish line B; 50 real accounts |
| AI-assisted code he cannot explain | medium | high | Every milestone closes with a spoken walkthrough; keep decisions in file headers where they already are |
| Supabase free tier: paused projects (F1 happened once), no backups | medium | medium | Project kept active weekly; restore drill in M8; consider Pro only when real users exist |
| The status page drifts again (F3) | medium | medium | Test that fails when a `schema-only` route has a real page |
| Legal: student data, drafts still marked drafts | medium | medium | M8 legal review before the pilot opens to anyone outside his batch |
| Time: 9–15 h/week against a 200-hour plan | **certain** | medium | Three finish lines, each defensible; estimates in sessions so slippage is visible early |

---

## 9. Next seven actions (this week)

1. **Commit and push the in-flight work** (F2). Nothing else is as urgent — it is a day of
   work with no backup.
2. **Create the Supabase project and run `npm run db:push` + `npm run db:check`** (F1). Then
   sign up once and post once, in a browser, and confirm the row exists.
3. **Add `src/lib/db/database.types.ts`** (F6) and re-run verify.
4. **Update `build-status.ts`** (F3) — profiles, universities, projects, onboarding.
5. **Add `.github/workflows/ci.yml`** (F5) and protect `main`.
6. **Create the GitHub repo + board + labels + milestones** from
   [issues.json](issues.json) via `scripts/github/bootstrap.mjs` (see [GITHUB.md](GITHUB.md)).
7. **Fix the doc drift** (F4) and pick the licence (F10).

Then M1's remaining sessions, then M2.

---

## 10. What this plan deliberately does not do

- It does not plan the out-of-scope list in PRODUCT.md (GitHub sync, AI mentor, video calls,
  native apps). Those stay out; they are how this project gets interesting but unfinished.
- It does not add infrastructure. No Redis, no queue, no Kubernetes, no microservices — the
  architecture's restraint is a feature and rate limiting is Postgres-backed for exactly this
  reason.
- It does not raise the estimate to look safe or lower it to look quick. 200 hours for finish
  line C is the number the milestones add up to.
