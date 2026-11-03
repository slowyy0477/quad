# Bulla — product and implementation scope

Reviewed against the current feature ledger and recovery records on
31 October 2026. This is a product/source snapshot, not hosted acceptance,
a security sign-off or a launch announcement.

## Public identity and current plan

The public product name is **Bulla**: a campus community for people, work and
learning. The shared identity lives in
[`src/lib/brand.ts`](../src/lib/brand.ts), used by the app metadata, wordmark
and PWA manifest.

The active source path remains `E:\Uni-Social-Network` intentionally.
Operational paths, existing data/session identifiers and historical URLs are
compatibility/provenance, not instructions to rename or move the checkout.
The August prototypes are requirements/UI references, not alternative active apps;
see the [archive review](bulla/ARCHIVE-REVIEW.md).

The [Bulla plan](bulla/PLAN.md), [current status](bulla/STATUS.md) and
[issue register](bulla/ISSUES.md) are the canonical recovery records.
Earlier `docs/plan/` milestones and implementation counts are not current.
The product is unfinished and is not cleared for public launch.

## The core loop

Make a profile → find people or work → share or join something → collaborate
→ keep a record of progress. Prioritize that loop over adding more feature names.

Five questions guide the product:

1. Who am I? Profile, campus affiliation, self-declared skills and interests.
2. What am I learning? Semesters, goals, milestones and daily study records.
3. What am I building? Projects, updates, ideas and collaboration needs.
4. Who can I build with? People discovery, follows/connections and conversations.
5. What should I do next? Useful context from real goals, projects and requests.

These are design goals, not a claim that every journey is finished. The current
feed can link to real projects/goals; richer privacy-safe portfolio evidence,
people-by-skill/department discovery and next-action/upcoming-event context
remain work. Do not imply that every post is attached to an object or that
automatic goal/project sharing exists everywhere.

## Existing implementation and its limits

The hand-maintained [`src/lib/build-status.ts`](../src/lib/build-status.ts)
ledger is rendered at `/status`. Its notes define the scope of each entry.
Review those notes with source and test evidence; sharing a ledger between
pages reduces duplication but does not make it automatically accurate.

| Ledger state | Interpretation |
| --- | --- |
| `working` / “Verified scope” | The explicitly recorded implementation/test scope exists; not blanket hosted, security or production verification |
| `partial` / “Partly complete” | Real implementation exists, but functionality, provider parity or acceptance is unfinished |
| `schema-only` / “Database only” | Schema/policies/tests without a user interface; do not apply this label to the implemented domains below |
| `planned` / “Not implemented” | No accepted implementation of the stated deliverable; do not present it as usable |

This summary deliberately avoids frozen migration/test/feature totals:

| Domain | Current scope | What remains |
| --- | --- | --- |
| Database foundation (`working`, scoped) | Versioned PostgreSQL migrations, RLS, explicit grants and in-process permission tests | Hosted PostgREST behavior, authorization regressions and operational/load acceptance |
| Accounts/onboarding (`partial`) | Local signup/sign-in/session actions; hosted Auth/OAuth/recovery-request code; onboarding screens/actions | Full hosted identity/email flow, password-reset completion, explicit initial publication choice and provider policy |
| Profiles/campus/social graph (`partial`) | Profile view/edit, skills/interests, university browsing/requests/review, follow/connect/block controls | Privacy-safe portfolio sections, richer people discovery and cross-mode/two-account acceptance |
| Feed (`partial`) | Composer, structured posts, ranking/filter queries, permalinks, cursor controls, likes/comments/saves | Ordering, bounded query work, retries/concurrency and write/reload/privacy acceptance |
| Projects/ideas (`partial`) | Lists/details/forms, members/applications/roles, updates, votes/interest and idea conversion | Ownership/role edges, atomic conversion and complete hosted collaboration journeys |
| Messages/notifications (`partial`) | Inbox/thread/group actions, read/unread controls, notification list and shell badge; cloud Realtime subscriptions | Departed-history/DM rules, reconnect/idempotency, private delivery and fan-out tests; local mode is not realtime |
| Learning/achievements (`partial`) | Semesters, courses, goals/milestones, daily logs, stored achievement display and award code | Date/timezone boundaries, real-event award idempotency and provider-parity journeys |
| Boards/search (`partial`) | Opportunities/events create/detail/list, bookmarks, RSVPs, search queries/results/tabs | Listing trust, board report coverage, RSVP capacity races, people filters/paging and large-dataset query plans |
| Reports/bugs/admin (`partial`) | Report/decision actions, bug submission/triage, audit/admin and university review screens | Direct-API authorization, abuse protection, board coverage and verified staff operations |
| Design/PWA/browser coverage (`partial`) | Bulla tokens/identity, light/dark controls, shared shell/navigation, install assets, public offline help and local smoke specs | All-screen redesign, real device/keyboard/accessibility/state QA and comprehensive two-account/hosted tests |
| Operations | Rate limiting is `partial`; safe uploads, account export/deletion and capacity/recovery proof are `planned` | Mandatory write budgets, private validated media, reauthenticated lifecycle/cleanup, monitoring and recorded load/restore evidence |

The existence of a screen, migration, action or test file does not establish
that its complete user journey passed. Current results and issue states belong
in the recovery records, not assumptions made from this table.

## Private development versus hosted service

With `NEXT_PUBLIC_DATA_MODE=local`, accounts and content are stored in a private
JSON file on the developer's machine (`LOCAL_DATA_PATH`, or `data/local.json`
when unset). This adapter supports review without a Supabase project. Local
sample content exists; it is not real student activity, verified identity or
evidence of adoption.

Local access/session checks are application code, not database RLS. Local mode
does not offer Google OAuth, email verification/recovery or cloud Realtime.
Keep it loopback-bound; a private production-build override does not make it
safe for public use. Preserve existing data and compatibility paths.

Supabase mode is the intended hosted architecture: Auth, PostgreSQL/RLS,
authorized Realtime and a future safe private-storage pipeline. Hosted
configuration and complete Auth/PostgREST/Realtime/storage journeys are still
release gates. Choosing the provider does not prove authorization or capacity.
See the [README setup/commands](../README.md) for the two modes.

The PWA provides install assets and public offline help. It does not promise
offline messaging, offline authenticated content or queued offline writes.
The service worker is designed not to cache account pages, APIs or private RSC
payloads; real-device/provider testing remains part of acceptance.

## Product honesty requirements

These are acceptance requirements, not an assertion that a full audit has passed:

1. Show only counts and progress with a defined data source. Do not describe
   seeded/sample counts as live usage, verified mastery or measured capacity.
2. Controls must perform their stated action and show pending/error/empty/access
   states. Missing functionality must be absent or explicitly non-operational.
3. Campus affiliation and skill levels are self-declared unless an actual
   verification process exists. Do not import prototype percentages or “active
   now” claims as measurements.
4. Respect visibility, blocking, roles and membership in queries/actions and
   the hosted database boundary, not just hidden controls. Explicit onboarding
   publication choice remains unfinished; current defaults are not consent proof.
5. Describe recovery, uploads, export/deletion and session controls by what
   users can actually complete. In particular, a reset email request currently
   targets the missing `/settings/password` route.
6. Opportunity bookmarks do not prove applications. Reviewed listings,
   application tracking and broader event/opportunity reporting cannot be
   advertised as complete when their workflows are missing.
7. Draft legal pages need human review. Local tests, a dependency audit,
   redesigned shared components or an installable PWA do not constitute legal,
   security, full-redesign or production readiness.

## Release gates and the 50,000-user target

The target is **50,000 registered accounts**, not 50,000 concurrent users.
No measured capacity benchmark or successful restore drill has been recorded
in the current ledger. Proposed traffic, latency, accessibility and recovery
budgets are targets until evidence demonstrates them.

Before a public launch or broader campus rollout:

- Close database/server authorization gates for personal settings, conversation
  roles, report eligibility, departed history, DM policy and mandatory abuse
  budgets; verify rejected direct-API attempts as well as legitimate flows.
- Complete recovery/account management, safe uploads, export/deletion and
  ownership/retention cleanup; reconcile email/password policy and staff MFA.
- Finish the core two-student journeys, board trust/reporting and staffed
  moderation; verify privacy, blocking and ownership across both providers.
- Finish per-screen design and loading/error/empty/access states, plus real
  device, keyboard, contrast and accessibility checks against the Bulla
  [design contract](bulla/DESIGN.md).
- Record hosted staging, forward-migration rehearsal, Auth/OAuth/email,
  PostgREST/RLS, Realtime/reconnect, private-storage and independent concurrency
  evidence. Embedded PGlite/local tests alone cannot supply this proof.
- Measure realistic isolated-staging load/soak/spike workloads, query plans,
  failure recovery and an actual backup restore under the
  [capacity test contract](bulla/PLAN.md#6-capacity-test-contract).

Use [ISSUES.md](bulla/ISSUES.md) for exact defects and current fix states and
[PLAN.md](bulla/PLAN.md) for milestone acceptance. This document does not close
those issues or authorize deployments, live migrations or load against an
external service.

## Deferred scope

AI assistants, GitHub sync, mentorship matching, video calls, verified
university identity, broader clubs/course communities, resource libraries,
application tracking, certificates/reputation scores and native mobile clients
are not completed MVP capabilities. Defer expansion until the web/PWA core and
release gates are reliable. Monetisation is not a recovery milestone; sample
data cannot justify adoption, engagement, revenue or infrastructure-cost claims.

