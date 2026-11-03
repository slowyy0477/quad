# Architecture

Current Bulla direction: [modular-monolith/capacity plan](bulla/PLAN.md) and
[status](bulla/STATUS.md). The foundation rationale below predates many domain
implementations; it is not the current feature ledger or hosted acceptance.

> Status: **target design.** This document was written before implementation and
> describes where the codebase is going. Change it before changing the structure it
> describes.
>
> **Where the code differs from this document today** — stated up front, because a
> design doc that quietly disagrees with the repository is worse than no design doc:
>
> | This document says | The code does | Why |
> | --- | --- | --- |
> | `src/modules/<domain>/` | `src/features/<domain>/` | renamed for consistency with the route groups; the boundaries are the same |
> | `schema.ts` / `service.ts` per domain | `schemas.ts`, `queries.ts`, `actions.ts`, provider-local adapters | keep domain boundaries; add service abstractions when behavior warrants them |
> | route groups `(marketing)`, `(auth)`, `(app)` | flat routes under `src/app/` | route groups get added when a group needs its own layout; two of them do not yet |
> | `lib/supabase/middleware.ts` | `src/proxy.ts`, beside `src/app` | installed Next.js requires the matching app/source location; root placement did not load the proxy |
> | ESLint `no-restricted-imports` enforces §3 | not configured | the four rules in §3 are followed by hand and are not yet mechanically enforced |
> | `revalidateTag('feed:${user.id}')` | `revalidatePath('/feed')` | see §4 |
> | `lib/rate-limit/` | limiter wrapper and migration 0021 exist | mandatory direct-write budgets are still a release gate |
> | Realtime (§4), Storage | conversation subscriptions exist; safe upload pipeline is unfinished | hosted authorization/delivery/reconnect remain acceptance work |
>
> Section 12 is a historical foundation snapshot; use `/status` and the Bulla
> records for the implemented-but-incomplete domain inventory.

## 1. What this is

A **modular monolith**: one Next.js application, one Postgres database, hard internal
boundaries between domains as the design goal. The current application groups domains
under `src/features/` and has a separate private local JSON adapter. Import discipline
is a review convention, not a configured ESLint restriction. No microservice rewrite
or measured production capacity is implied by this structure.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | RSC lets reads happen server-side with no client bundle cost |
| Language | TypeScript, `strict` | non-negotiable for a schema this size |
| Styling | Tailwind CSS v4 | CSS-first config; tokens live in `globals.css` |
| Primitives | Radix UI via shadcn-style local components | accessible building blocks; application accessibility still needs verification |
| Database | Supabase Postgres | RLS is the security floor |
| Auth | Supabase Auth (email/password + Google OAuth) | cookie-based SSR sessions |
| Realtime | Supabase Realtime | conversation subscription code exists; local mode is not realtime; hosted proof pending |
| Storage | Supabase Storage | avatars, post media, attachments — **not wired yet** |
| Validation | Zod | one schema shared by client form, server action, and tests |
| Forms | React Hook Form + `zodResolver`, or `useActionState` | uncontrolled inputs, minimal re-render; the auth forms use `useActionState` because they post to Server Actions and must work without JS |
| Unit/integration | Vitest | fast, ESM-native |
| E2E | Playwright | isolated local browser smoke exists; comprehensive two-account/hosted coverage remains |

The Supabase entries describe the hosted path. In local mode, accounts/content use
`src/lib/local/` and TypeScript access checks, not Postgres RLS, Supabase Auth or
Realtime. That development adapter is not the database for the 50,000-account target.

### Next 16 notes that cost real debugging time

- `cookies()`, `headers()`, `params` and `searchParams` are **async**. Awaiting them is
  not optional.
- `middleware.ts` is now **`proxy.ts`**, exporting `proxy` rather than `middleware`.
- `next typegen` generates `PageProps<'/route'>` and `LayoutProps<'/'>` into
  the configured build directory's types. `npm run typecheck` runs typegen before
  TypeScript; see `package.json`.
- The proxy matcher **must** exclude `_next/static`, or an auth check runs in front of
  the stylesheet — and a redirect there does not fail loudly, it renders the site
  unstyled.
- A `'use server'` module may only export **async functions**. Exporting a plain object
  (a shared `emptyState` constant, say) throws at module evaluation. That is why
  `form-state.ts` files exist beside the `actions.ts` files.

For this installed Node.js proxy build, registration is in
`server/functions-config-manifest.json` under `/_middleware`, with `runtime: "nodejs"`.
An empty Edge-oriented `server/middleware-manifest.json` is not absence proof.
Manifest inspection and actual HTTP guard checks are separate evidence; see R16 in
[ISSUES.md](bulla/ISSUES.md).

## 3. Directory layout

**Historical target layout, illustrative rather than a checkout inventory.**
The actual routes are flat under `src/app/`, domains are in `src/features/`, and
the request proxy is `src/proxy.ts`. The tree's route groups, `service.ts`, `index.ts`
conventions and helper directories are proposals, not proof that those files exist.

```
src/
├── app/                        ROUTING ONLY. No business logic in here.
│   ├── (marketing)/            public, indexable: /, /about, /privacy, /terms, ...
│   ├── (auth)/                 /login, /signup, /forgot-password, /reset-password
│   ├── (onboarding)/           /onboarding — own layout, no app chrome
│   ├── (public)/               /@[username], /project/[slug], /university/[slug],
│   │                           /explore, /universities, /projects, /opportunities, /events
│   ├── (app)/                  authed shell: /feed, /dashboard/*, /messages, /notifications,
│   │                           /settings/*, /search
│   ├── admin/                  own layout + own guard
│   ├── api/                    route handlers ONLY where a Server Action can't work
│   │                           (webhooks, OAuth callback, file streaming, cron)
│   ├── layout.tsx  globals.css  error.tsx  not-found.tsx
│   ├── sitemap.ts  robots.ts  opengraph-image.tsx
│
├── modules/                    ← THE APPLICATION. One folder per domain.
│   └── <domain>/
│       ├── schema.ts           Zod. Imported by client AND server. No side effects.
│       ├── types.ts            derived + row types
│       ├── queries.ts          reads. server-only. returns view models, never raw rows.
│       ├── actions.ts          writes. 'use server'. thin: parse → guard → service → revalidate
│       ├── service.ts          business logic. testable. takes a client, returns Result.
│       ├── components/         domain UI (client or server)
│       └── __tests__/
│
├── components/
│   ├── ui/                     design system primitives. ZERO domain knowledge.
│   ├── layout/                 app shell, nav, sidebars, mobile nav
│   └── shared/                 cross-domain composites (Avatar+name, EmptyState, ...)
│
├── lib/
│   ├── supabase/               client.ts | server.ts | admin.ts | middleware.ts
│   ├── db/database.types.ts    GENERATED. never hand-edit.
│   ├── auth/                   guards, session helpers, role checks
│   ├── validation/             shared primitives (username, slug, file, pagination)
│   ├── errors/                 AppError taxonomy + safe user-facing messages
│   ├── rate-limit/             Postgres-backed fixed-window limiter
│   ├── config/                 brand.ts, nav.ts, feature-flags.ts, limits.ts
│   └── utils/
│
└── types/

supabase/migrations/            ordered, immutable once applied
supabase/seed/                  DEV ONLY. never runs against production.
scripts/                        db push, typegen, seed, create-admin
tests/{integration,e2e,security}/
docs/
```

### Proposed import rules (not configured in ESLint)

These rules belong to the target `modules/` layout above.
[`eslint.config.mjs`](../eslint.config.mjs) does not configure
`no-restricted-imports`; it cannot currently enforce these boundaries.

1. `components/ui/**` may not import from `modules/**` or `lib/supabase/**`.
2. `modules/a/**` may not import from `modules/b/**` *except* from `modules/b/schema.ts`,
   `modules/b/types.ts`, and `modules/b/components/**`. Cross-domain **data access** goes
   through the owning module's `queries.ts`, re-exported from its `index.ts`.
3. `app/**` may not import `service.ts` directly — only `queries.ts` / `actions.ts`.
4. Nothing outside `lib/supabase/admin.ts` may import the service-role key.

Under rule 2's proposal, feed would obtain profile data through the owning domain.
`profiles.getProfileCard(id)` is an illustrative API, not an existing export or
evidence that every current cross-domain query already follows that convention.

## 4. Data flow

### Reads — React Server Components

```text
page.tsx (RSC) → src/features/x/queries.ts
  hosted → createClient() → Supabase HTTP Data API / RPC → Postgres (RLS + grants)
  local  → readStore() → private JSON snapshot (TypeScript access checks)
```

Hosted reads use the caller's session, or anonymous access for public reads.
Domain queries assemble page-facing data; the directory layout alone does not
guarantee a uniform view-model contract or complete authorization. Local reads do not
exercise database policies. See [`server.ts`](../src/lib/supabase/server.ts) and
[`local/db.ts`](../src/lib/local/db.ts).

### Writes — Server Actions

[`src/lib/action.ts`](../src/lib/action.ts) **exists**. Selected hosted messaging,
moderation and bug-report actions use it; other actions, including feed/auth, have
hand-written paths, and local adapters use their own validation/access checks.
Direct Data API writes also exist independently of Server Actions, so the wrapper is
not a universal authorization or abuse-control boundary.

Illustrative excerpt of the hosted report pipeline in
[`moderation/actions.ts`](../src/features/moderation/actions.ts); imports, domain
error handling and the success payload are omitted:

```ts
const fileReport = action(reportSchema)
  .use(requireActiveAccount)
  .use(rateLimit('report:file'))
  .use(guard('You can only report something you can see.', targetIsVisible))
  .run(async ({ input, supabase }) => {
    const { error } = await supabase.from('reports').insert({
      kind: input.kind,
      reason: input.reason,
      detail: input.detail ?? null,
      [REPORT_TARGET_COLUMN[input.kind]]: input.targetId,
    })
    if (error) throw error
    revalidatePath('/report-a-bug')
  })
```

The builder parses input and verifies a hosted user, then runs only the steps attached
by its caller, maps failures to a typed result and invokes the domain write. Account
restriction predicates/content-insert triggers are in migration `0020`; the
fixed-window limiter and RPC are in `0021`. General posting/message budgets,
caller-selected limiter parameters and direct-write bypass remain S06 acceptance work
in [ISSUES.md](bulla/ISSUES.md).

The hosted feed insert in [`feed/actions.ts`](../src/features/feed/actions.ts) omits
`author_id`; `0008_posts.sql` supplies/guards authorship at the database. This is a
specific write contract, not evidence that all mutations share the same wrapper.

### Caching decision: `revalidatePath`, not tags — for now

Current feed writes call `revalidatePath('/feed')`, not `revalidateTag`. Authenticated
results must not be shared across users merely to gain caching. Any future tagged
cache needs an explicit ownership/privacy and invalidation design.

The installed Next.js reference at
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md`
documents `revalidateTag(tag, profile)` and deprecates the single-argument form.
The old one-argument statement is not valid guidance for this installed version.

### Realtime

Messaging has an inbox/thread UI at [`/messages`](../src/app/messages/page.tsx).
[`ThreadRealtime`](../src/features/messages/components/thread-realtime.tsx) mounts a
conversation-filtered Postgres Changes subscription through
[`channel.ts`](../src/features/messages/components/channel.ts). Payloads signal a
server refresh rather than supplying message content for direct rendering.

The shared helper supports `messages` and `notifications`; that support alone does
not prove a notification subscription is mounted. Local mode opens no socket or
polling interval and offers manual refresh. Hosted publication, row filtering,
two-session isolation and reconnect behavior still need acceptance; PGlite SQL tests
do not verify the Realtime service.

## 5. Security model — three independent layers

Defense in depth is the design goal, not a recorded proof that any layer can fail
independently without a breach.

1. **RLS and explicit grants** on hosted exposed tables. Internal operational tables
   are a different audience. Assume the client is hostile and has the anon key.
2. **Server-side guards** in pages, selected wrapped actions and provider adapters.
   Ownership, role and membership must not depend on a hidden button.
3. **Column-level `GRANT`s**. `authenticated` has no `UPDATE` privilege on
   `profiles.status`, `profiles.username_changed_at`, or anything in `user_roles`. Role
   changes to those columns are refused independently of an own-row UPDATE policy.

Roles live in `user_roles`, **not** on `profiles`, precisely so a user's own-row UPDATE
policy can never grant them admin.

Security-definer helpers pin `search_path`; some helpers deliberately use
`security invoker`, including the report-target trigger in forward migration `0023`.
The schema tests check grants and helper hardening, not every hosted service.
Conversation roles, departed history and direct-write budgets have separate gates
in [ISSUES.md](bulla/ISSUES.md).

See [SECURITY.md](SECURITY.md).

## 6. Pagination

Feed, thread/inbox and notification queries have keyset cursor paths. Admin queues use
page/range pagination. That is not proof that every growing reply/member/search read
is bounded or that local and ranked hosted ordering are identical.

The target is stable cursor-based paging for growing user-facing lists, with offsets
reserved for deliberate admin page controls. Reply/member paging, ranking/count
budgets and realistic query plans remain [F08 work](bulla/ISSUES.md).

## 7. Counters and derived data

Hosted migrations maintain denormalized counters where defined. Other reads, including
admin queues and notification counts, explicitly request exact counts; local views
derive values from store rows. There is no universal “no counts in list views” rule
already enforced by the code.

Displayed values must have a readable stored source or be clearly labeled development
fixtures. Query-cost and privacy checks remain per-view acceptance work. See
[product honesty requirements](PRODUCT.md#product-honesty-requirements).

## 8. Notifications

Hosted notifications are generated **in the database**, by triggers/functions using
`app.create_notification(...)`. Local adapters generate their own store rows; that
does not exercise the hosted trigger, preference or delivery contracts. Hosted reasons:

- the client cannot forge a notification,
- the sender cannot be trusted to write one,
- deduplication is a constraint rather than application logic that races.

**As built** (migration 0014), entity references use **typed, nullable foreign-key
columns** — `post_id`, `project_id`, `idea_id`, `conversation_id`, … — rather than a
polymorphic `(entity_type, entity_id)` pair. Not every notification has exactly one
target: moderation notices can have none. The migration's notification-type and
creation-function rules define the allowed shape. Typed
columns won for one reason: a polymorphic id has no referential integrity, so deleting
a post leaves a notification pointing at nothing, and every read has to defend against
it. With real foreign keys, `on delete cascade` removes the notification with the row
it refers to, and the database — not a query — guarantees the target exists.

The cost is a wider table and a migration whenever a new notifiable entity appears.
That is a good trade: adding a column is a decision someone reviews, which is what you
want when the question is "should this generate a notification".

`notifications_dedupe` uses `unique nulls not distinct` over recipient, type, actor
and the typed target columns. Its null handling makes otherwise-identical nullable
references participate in deduplication.

## 9. Error and state contract

The completion contract is four states: loading (`loading.tsx` or Suspense), error,
empty and content. This is a review/acceptance requirement, not an inventory claim that
every current route has passed those checks.

`src/app/error.tsx` renders `error.digest` **only**, never `error.message`: in a Server
Component that message can contain a query, a path, or row data.

## 10. What is deliberately NOT here

- No custom recommendation ML. Feed ranking is a documented SQL function, swappable.
- No AI dependency in any core path.
- No GitHub sync in MVP (schema has the columns; sync is a later module).
- No complete durable job/worker pipeline. A reminder-dispatch SQL function exists;
  scheduled dispatch is setup work, not evidence of an active `pg_cron` job.
- No Redis dependency. A Postgres limiter exists for selected calls; mandatory abuse
  controls and measured multi-instance capacity are unfinished.

Durable jobs and infrastructure changes in [PLAN.md](bulla/PLAN.md) remain proposals
until implemented and verified.

## 11. Decisions

Migration headers and domain comments contain foundation rationale, but can themselves
lag implementation. Use the current [plan](bulla/PLAN.md) and
[issue register](bulla/ISSUES.md) for unresolved decisions and acceptance gates.
Historical comments are context, not authorization to change an external system.

## 12. What exists today

[`src/lib/build-status.ts`](../src/lib/build-status.ts) is the hand-maintained
feature ledger rendered at `/status`. Its per-feature notes define the verified or
incomplete scope; configuration presence does not make a feature usable end to end.
Source inspection and recorded results must keep that ledger honest.

| State | Scope-qualified reading |
| --- | --- |
| `working` | the explicitly recorded scope is verified, not a public-launch approval |
| `partial` | implementation exists with named gaps or acceptance still pending |
| `schema-only` | database work exists without a corresponding interface |
| `planned` | not implemented |

The old foundation counts and “all domains except auth/feed are SQL-only” description
are obsolete. Profiles/social graph/skills, projects/ideas, learning, messages,
boards/search, notifications and moderation/bugs have application code as well as
database work. Examples include [`profiles/actions.ts`](../src/features/profiles/actions.ts),
[`messages/page.tsx`](../src/app/messages/page.tsx) and
[`admin/page.tsx`](../src/app/admin/page.tsx).

Keep volatile test totals and verification results in [STATUS.md](bulla/STATUS.md)
and timestamped evidence, not this guide. Hosted Auth/PostgREST/Realtime/storage,
recovery and load acceptance remain distinct from local source or test evidence.
