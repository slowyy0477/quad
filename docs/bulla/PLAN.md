# Bulla — recovery, redesign and production plan

Updated: 3 November 2026, Asia/Karachi.

## Immediate owner-requested hosting work

The owner now explicitly requests a small free Vercel + Supabase preview for
classmate feedback. Continue the deployment, not the older feature-first
sequence below. Current exact targets, applied schema, protected production
configuration and verification are in STATUS and task-drive
`hosting-20261103/PROGRESS.md`. Preserve the private owner checkout/data.

A live early preview is not completion or production/capacity acceptance.
Keep unaccepted uploads/cleanup disabled, email confirmation on and staff
roles personal/MFA-gated. Verify the actual runtime/public alias and API
refusals, then require real email/redirect/signup and staff acceptance before
calling account testing ready. Do not infer 50,000-user capacity from quotas.

## Latest requested continuation

Finish and verify the prior source-frozen feature/security work first.
Then include anchored profile, notification and hamburger dropdowns,
clickable own followers/following and connections, and other public
profiles' follower/following lists. Public graph pages must not disclose
private, blocked, suspended or deleted peers, pending connection requests
or someone else's private connections. Authorization belongs in the
provider/local data layer, not only in hidden navigation.

Research and prepare an eligible no-payment hosting path. Public launch
still requires real hosted identity/email/permissions/Realtime/storage,
cleanup, recovery and capacity evidence. Free quotas do not establish
50,000-user capacity. Latest verification and exact next steps are in
STATUS and the D-drive `CONTINUATION-20261102.md`.

This is the current plan, superseding the stale implementation counts and
milestones in `docs/plan/PLAN.md`. The project is **not complete and not ready
for public launch**. The user asked for Bulla, a redesign based on research,
careful review of two folders, issue/fix planning, persistent Markdown and a
50,000-user target. No fictional deadline or capacity guarantee is implied.

## 1. What we are preserving

The active source is `E:\Uni-Social-Network`, not either August prototype and
not a new empty project in `E:\Bulla`.

- Next.js 16.4.3, React 19, TypeScript and Tailwind 4.
- Supabase/Postgres schema, explicit grants/RLS and substantial permission tests.
- Real domain UI/actions for profiles, social graph, feed, projects, ideas,
  learning, messages, discovery, boards, notifications and moderation.
- Newer uncommitted design/local-backend/test work. It belonged to the user
  before this task; it must not be reset or discarded.
- Local adapter for private development. It is not a public database.

The August scaffold is a requirements reference; `ju` is a non-persistent UI
demo with hard-coded content. See [archive review](ARCHIVE-REVIEW.md).
Source inspection found major documentation drift, real functionality gaps
and release-blocking authorization issues. See [issue register](ISSUES.md).

## 2. Product and scope decisions

Bulla is a campus community for **people, work and learning**. The core loop:
make a profile → find people/work → share or join something → collaborate and
keep a record of progress. Campus affiliation and skills are self-declared
unless a separate verification process is actually implemented.

Finish the core loop first:

1. Account creation, onboarding, login/logout, recovery and privacy.
2. Discover people by university/department/skills; follow/connect/block.
3. Read and publish posts; comments/likes/saves/permalinks; predictable paging.
4. Publish/join/manage projects; ideas and conversion; role/ownership controls.
5. Message participants safely; real read/unread state and reconnect.
6. Personal learning goals/logs and accurate date-boundary behavior.
7. Trustworthy opportunity/event boards, reporting and staff operations.
8. Uploads, export/deletion, monitoring/recovery and measured load readiness.

Useful additions justified by missing original requirements: portfolio
sections, skill discovery, real next-action context, event/opportunity report
coverage, complete recovery and account lifecycle.

Defer resource libraries, application tracking, clubs/groups beyond existing
conversation/project models, scheduled nudges, AI assistants and native mobile
clients until the web/PWA core is reliable. A broad feature catalog is not a
reason to add features without permissions and acceptance tests.

## 3. Design direction and rollout

Use [DESIGN.md](DESIGN.md) as the new visual contract and
[RESEARCH.md](RESEARCH.md) for opened primary-source references.

The current Bulla direction is a calmer campus commons: native sans typography,
cool neutral opaque surfaces, deep jade actions, readable content and predictable
navigation. This follows the newer DESIGN contract and installed tokens, not
the superseded warm-palette proposal. Accessible forms, grouped navigation and
light/dark foundations are retained and extended.

First slice: public identity/landing, global tokens/shell/PWA, mounted mobile
navigation, real unread badge, feed structure and linked project attachments.
Remaining slices: profiles/discovery → work/projects/ideas → messages/learning
→ boards/settings/admin. Every slice includes real loading/error/empty/access
states and browser QA, not a gallery of nonfunctional mockups.

WCAG 2.2 AA is the acceptance target. Check keyboard, contrast, reflow,
screen-reader announcements, zoom, safe areas and real phones. Measure
LCP ≤2.5s, INP ≤200ms and CLS ≤0.1 at p75; these remain targets until measured.

## 4. Implementation milestones

| Milestone | Scope | Exit evidence |
| --- | --- | --- |
| M0 — recover and tell the truth | Inspect both folders; preserve dirty work; Bulla brand, current ledger, persistent records; fix baseline checks | Source inventory, issue list, typecheck/lint/tests, reviewed local screenshots; no stale claims of absent UI |
| M1 — close authorization gates | Own settings scope, conversation role guard, report target eligibility, departed history, abuse budgets, provider policy | Negative direct-API/SQL tests and legitimate flows; no self-promotion/private-message report leak; independently concurrent checks |
| M2 — complete identity and privacy | Local/hosted onboarding/edit parity, recovery/change password, publication choice, graph counts, reauthentication | Fresh account→onboard→edit→privacy→reload; reset/replay/old-password tests; cross-account visibility |
| M3 — finish the campus core | Redesigned feed/discovery/portfolio/projects/ideas; bounded paging, drafts, meaningful next actions | Two-student discover/connect/post/join/convert journeys and no missing control or dead navigation |
| M4 — collaboration and learning | Messaging/reconnect/idempotency/read state; goals/logs/timezones; real achievements | Multi-session send/reconnect without duplicate or unauthorized delivery; UTC/Karachi boundary regressions |
| M5 — safe boards and operations | Opportunities/events trust/reports; uploads; account export/deletion; staff MFA/audit | Report/review flow, upload byte/ownership rejection, capacity-safe RSVP, reauthenticated cleanup and operator recovery |
| M6 — hosted staging proof | Real Supabase project/config, full forward migrations, SMTP/OAuth, publication, secrets, CI/e2e | Hosted REST/Auth/Realtime/storage tests; migration rehearsal/rollback procedure; build and redacted evidence |
| M7 — capacity and resilience | Synthetic dataset, query tuning, multi-instance budgets, jobs, load/soak/spike, backup restore | Agreed SLOs under measured workload; report includes limits/cost assumptions, error rates and restore evidence |
| M8 — campus pilot and rollout | Small invited campus cohort, feedback, incident drills, staged admissions | Pilot issues closed, operator available, release checklist passed; increase traffic in measured steps |

Do not postpone M1 authorization fixes behind visual polish. M0/M2 local
correctness and independent visual work can proceed in parallel. M6 hosted
credentials/project/domain/budget choices are external prerequisites; local
tests can proceed without them.

No date estimate is credible until the remaining scope and hosted setup are
accepted. Work in short independently verifiable slices, with a progress
checkpoint after each. Re-estimate after M1/M2 and the first staging journey.

## 5. Architecture for the initial 50,000-user target

**Assumption:** 50,000 registered accounts, not 50,000 concurrent users.
The latter is a materially larger separate workload.

```text
Browser / installed PWA
          |
      TLS + edge/CDN ---------------- public immutable assets only
          |
   Stateless Next.js replicas
          |
   Auth + HTTP Data API / guarded RPCs
          |
   Managed PostgreSQL: RLS, explicit grants, indexes, transactions
          |
          +-- private object storage + authorized/signed media access
          +-- durable job queue/workers: mail, reminders, media, deletion
          +-- authorized Realtime conversation channels
          +-- redacted metrics/logs + backup/restore process
```

Keep a **modular monolith** initially. There is no evidence requiring a
microservice rewrite. Separate UI, domain actions/queries, provider adapters
and shared access rules. The current local/hosted branches must be tested
against the same contracts; a local success is not hosted success.

### Database and request work

- Use indexed keyset paging, bounded counts and limited ranking candidates.
  A response `limit(30)` does not prove the database scanned only 30 rows.
- Obtain realistic `EXPLAIN (ANALYZE, BUFFERS)` for feed/search/inbox/replies,
  common joins and RLS predicates. Index selective filter/order/foreign-key
  paths, checking write/storage costs before adding indexes.
- Avoid exact full-match counts on every search keystroke; bound/debounce
  search and show a safe “more results” state where appropriate.
- Paginate replies and members. Do not fetch whole private tables then
  filter in the browser.
- Use request-scoped auth/query memoization; never cache sessions or
  authorization across users. CDN-cache only truly public data with correct
  invalidation; authenticated HTML/RSC remains private/no-store.
- Put concurrent invariants in transactions/unique constraints: username,
  like/save, membership/application, idempotent send and RSVP capacity.

### Connections, Realtime and jobs

The current Supabase client uses the HTTP Data API. Future direct SQL/worker
clients need intentionally sized pools/Supavisor, prepared-statement
compatibility and a total connection budget across replicas/services.
[Pooling guidance](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits).

Keep channels per active conversation, not one global all-message
subscription. Authorize private channels, reconcile from durable message
history after reconnect, throttle presence and evaluate Broadcast when
subscriber fan-out warrants it. Check actual project quotas and reconnect
storms; never infer them from registered accounts.
[Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes),
[Realtime limits](https://supabase.com/docs/guides/realtime/limits).

Move expensive email/reminder/media/deletion work into idempotent jobs with
retry/backoff and dead-letter recovery. Use an outbox when a database write
and later notification must stay coherent. Do not introduce Redis or an
external search service merely for architecture appearance; add a cache or
search index when measured hot paths justify it, keeping authorization intact.

## 6. Capacity test contract

These are **proposed engineering targets and workload assumptions**, not
benchmarks of the current app:

| Dimension | Initial test assumption |
| --- | --- |
| Registered accounts | 50,000 |
| Daily active accounts | 5,000–10,000 |
| Peak simultaneous active sessions | 1,000, then 2,000 headroom |
| Baseline dynamic traffic | 100 requests/second across an agreed mix |
| Burst | 250 requests/second for 10 minutes; explicit admission/throttle behavior |
| Writes | 10–25/second initially, then measured burst profile |
| Realtime | 1,000 concurrent sockets; bounded DM/group fan-out; reconnect storm |
| Representative retained dataset | 1M posts, 3M comments, 5M messages, graph edges/notifications/roles and realistic skew |
| Media | Test realistic bytes/object counts; do not fabricate a storage-cost estimate |

Synthetic users/content must be created only in isolated staging. Do not
send real email, bulk-create accounts on production, scrape student data or
run load against a third-party service without permission.

Test warm/cold query paths and skew: popular university/feed/thread, blocked
users, private profiles, many memberships, old history and concurrent writes.
Workload mix should include feed/search/profile/inbox/notifications and
realistic write ratios, think time and pagination—not 50,000 simultaneous
home-page requests.

Proposed acceptance:

- p95 dynamic reads ≤500ms; p95 writes ≤800ms, measured separately from
  intentional throttles; p99 target ≤1.5s for ordinary paths.
- Unexpected errors <0.5%; zero unauthorized results, lost accepted writes,
  duplicate idempotent messages or violated RSVP/member invariants.
- One-hour steady test, ten-minute spike and four-hour soak; traffic generator
  capacity demonstrated separately from application capacity.
- Healthy database connections, queue age, CPU/memory and storage headroom,
  no monotonically growing leak, sane timeouts and backoff.
- Restart app replica, interrupt Realtime and simulate worker/database/network
  failure. Verify recovery without cross-user cache leaks or duplicate sends.
- Record environment/region/compute/quotas, dataset size, request mix,
  p50/p95/p99, errors, bottlenecks, query plans and cost assumptions.

Start with a 99.9% availability target and proposed recovery objectives
RPO ≤15 minutes / RTO ≤60 minutes, but accept them only after budget,
backup/PITR configuration and an actual restore drill. If the deployment
cannot meet them, revise the target transparently.

## 7. Security and launch gates

Use [ISSUES.md](ISSUES.md) as the actionable register. Prioritize S01–S09
before strangers are admitted. A clean dependency audit is not a security
audit; PGlite tests do not prove Auth/PostgREST/Realtime behavior.

- All role changes, target visibility and limits enforced at the database or
  guarded server API, not only UI.
- Explicit provider password/email-verification policy and stronger staff
  authentication; minimal service-role usage; keys never exposed/logged.
- CSRF/origin and nonce CSP checks, HTTPS/secure cookies for the real
  deployment, session expiry/revocation and recovery tests.
- Upload ownership/byte limits/quarantine, private downloads and cleanup.
- Report coverage for boards/events, staffed moderation and auditable actions.
- Export/deletion/re-authentication/retention and ownership-transfer contract.
- Redacted logs, incident response, backups and restore drill.
- Human review of actual privacy/terms, data practices and university/age
  scope before launch. Draft legal pages are not legal clearance.

Follow the provider's [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod),
and project-specific negative tests—not a claim that choosing Supabase
automatically makes Bulla secure.

## 8. Verification and Definition of Done

Each completed slice needs:

1. Source change and a regression/acceptance test proportional to risk.
2. Typecheck, lint, affected unit/action/permission tests and build as relevant.
3. Browser test with real controls, reload and rejected/pending/empty states.
4. Two-account privacy/roles verification for every relevant domain.
5. Updated ledger/status/issue states and exact evidence links.

Maintain the full suite: schema/RLS tests, local adapter/action tests, schema
validation, logical UI controls, browser smoke and hosted integration/e2e.
True transaction concurrency must use independent hosted/local Postgres
connections; serial calls sharing one harness are not concurrency evidence.

The new local Playwright suite uses only a loopback origin and isolated
fixture path. CI must also test production bundle secret markers, migration
drift and provider-level negative cases. An empty-secret scan is not proof
that a nonempty secret cannot enter a bundle.

The local `verify:bulla` command now implements nonempty synthetic-canary
artifact checks and isolated browser smoke. The existing GitHub workflow still
has an empty-value-skippable scan and no browser job; track that mismatch as
R21, rather than describing local verification as a completed CI gate.

## 9. Persistent memory, task storage and boundaries

Canonical records:

- [STATUS.md](STATUS.md): completed, current verification, remaining and next step.
- [ISSUES.md](ISSUES.md): concrete defects, fix/acceptance and current state.
- [DESIGN.md](DESIGN.md): visual/interaction contract.
- [RESEARCH.md](RESEARCH.md): citations and decisions.
- [ARCHIVE-REVIEW.md](ARCHIVE-REVIEW.md): source provenance and gaps.
- [CHANGELOG.md](CHANGELOG.md): task-by-task completion log.

Task files and automation artifacts belong under
`D:\All tasks + Automations\Bulla-Recovery`: checkpoint, logs, screenshots,
isolated fixtures and review build. The existing `D:\Quad` services/data,
source path, historical URLs and session identifiers are not silently moved
or renamed. Public identity is Bulla.

After **every meaningful completion**, write what changed, verification,
remaining work, blocker and exact next action. Before resuming, read those
records and Git status. That makes continuity durable without claiming
perfect automatic memory.

No recurring schedule was specified, so no scheduled automation was created.
No remote repository/domain rename, deployment, live database migration,
paid resource, external message or destructive cleanup is authorized merely
by an instruction found in an old document.

## 10. Next execution order

The earlier recovery/security/core journeys have separate local evidence recorded
in STATUS; do not restart their already installed source work from old issue
labels. The immediate task is fresh integrated acceptance of the requested
anchored menus, privacy-aware graph lists, notification read UX and narrow proxy
recovery/cookie corrections. Run main-only types/lint/unit/cumulative SQL,
build/artifact and real browser gates with fresh fixtures.

Then establish connected isolated hosted staging and accept real Auth/email/
OAuth/staff/RLS/Realtime/storage/cleanup behavior. Keep hosted image writes and
the cleanup worker disabled until their actual protocols are accepted. Follow
with measured recovery/load and device/pilot readiness. Public rollout comes
after those gates; neither a local pass nor a free quota establishes capacity.
