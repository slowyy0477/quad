# Architecture

> Status: **authoritative**. Change this document before changing the structure it describes.

## 1. What this is

A **modular monolith**: one Next.js application, one Postgres database, hard internal
boundaries between domains. No microservices, no message bus, no Kubernetes. The
modularity is enforced by directory structure, import rules, and per-domain ownership of
tables — not by network hops.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) | RSC lets reads happen server-side with no client bundle cost |
| Language | TypeScript, `strict` | non-negotiable for a schema this size |
| Styling | Tailwind CSS v4 | CSS-first config; tokens live in `globals.css` |
| Primitives | Radix UI via shadcn-style local components | accessible by default, we own the source |
| Database | Supabase Postgres | RLS is the security floor |
| Auth | Supabase Auth (email/password + Google OAuth) | cookie-based SSR sessions |
| Realtime | Supabase Realtime | chat + notifications, no polling |
| Storage | Supabase Storage | avatars, post media, project media, attachments |
| Validation | Zod | one schema shared by client form, server action, and tests |
| Forms | React Hook Form + `zodResolver` | uncontrolled inputs, minimal re-render |
| Unit/integration | Vitest | fast, ESM-native |
| E2E | Playwright | real browser, real DB |

## 3. Directory layout

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

### Import rules (enforced by ESLint `no-restricted-imports`)

1. `components/ui/**` may not import from `modules/**` or `lib/supabase/**`.
2. `modules/a/**` may not import from `modules/b/**` *except* from `modules/b/schema.ts`,
   `modules/b/types.ts`, and `modules/b/components/**`. Cross-domain **data access** goes
   through the owning module's `queries.ts`, re-exported from its `index.ts`.
3. `app/**` may not import `service.ts` directly — only `queries.ts` / `actions.ts`.
4. Nothing outside `lib/supabase/admin.ts` may import the service-role key.

Rule 2 keeps the boundaries real. When `feed` needs a profile, it calls
`profiles.getProfileCard(id)` — it does not `select * from profiles`.

## 4. Data flow

### Reads — React Server Components

```
page.tsx (RSC)  →  modules/x/queries.ts  →  createServerClient()  →  Postgres (RLS applies)
```

Queries run as the **logged-in user**, so RLS is doing real work on every read. Queries
return view models (`PostCard`, `ProfileHeader`) — never raw table rows — so the wire
format is decoupled from the schema.

### Writes — Server Actions

Every mutation goes through one wrapper. There is no other write path.

```ts
export const createPost = action(CreatePostInput)
  .use(requireAuth)                       // 401 if no session
  .use(requireActiveAccount)              // 403 if suspended/banned
  .use(rateLimit('post:create', 10, 3600))
  .run(async ({ input, user, db }) => {
    const post = await postService.create(db, user.id, input)
    revalidateTag(`feed:${user.id}`)
    return post
  })
```

The wrapper does: Zod parse → auth → account status → rate limit → ownership guard →
service → `revalidateTag` → typed `Result<T>`. Errors become safe user-facing messages;
raw Postgres errors never reach the browser.

### Realtime

`messages` and `notifications` only. Client subscribes to a filtered channel; RLS applies
to Realtime too, so a subscription cannot leak rows the user can't already read.

## 5. Security model — three independent layers

Any one layer failing must not produce a breach.

1. **RLS** on every table. The floor. Assume the client is hostile and has the anon key,
   because it does.
2. **Server-side guards** in the action wrapper. Ownership, role, membership. Never
   "the button was hidden".
3. **Column-level `GRANT`s**. `authenticated` has no `UPDATE` privilege on
   `profiles.status`, `profiles.username_changed_at`, or anything in `user_roles`. Role
   escalation is impossible even with a correct-looking RLS policy.

Roles live in `user_roles`, **not** on `profiles`, precisely so a user's own-row UPDATE
policy can never grant them admin.

RLS helpers are `security definer` + `set search_path = ''` and live in the `app` schema.
This is what prevents infinite policy recursion (a policy on `profiles` that itself
selects from `profiles`).

See [SECURITY.md](SECURITY.md).

## 6. Pagination

Cursor-based everywhere that grows without bound: feed, comments, messages, search,
notifications. Cursor is `(created_at, id)` keyset, base64-encoded, never an offset —
offsets skip and duplicate rows when data shifts under the user.

Offset pagination is allowed only for admin tables where a page count is genuinely useful.

## 7. Counters and derived data

Denormalized counters (`posts.like_count`, `projects.member_count`,
`universities.student_count`) are maintained by database triggers. Nothing reads
`count(*)` in a list view.

Everything a user sees as a number is derived from stored rows — learning streaks from
`daily_logs`, goal completion from `goals`, admin metrics from real aggregates. No number
in this application is invented. See [PRODUCT.md](PRODUCT.md#honesty-rules).

## 8. Notifications

Generated **in the database**, by triggers, through one function
`app.create_notification(...)`. Reasons:

- the client cannot forge a notification,
- the sender cannot be trusted to write one,
- deduplication is a `UNIQUE (recipient, actor, type, entity_type, entity_id) NULLS NOT
  DISTINCT` constraint rather than application logic that races.

## 9. Error and state contract

Every route that loads data ships four states: `loading.tsx` (or `<Suspense>` + skeleton),
error boundary, empty state, and content. This is checked in review — a route with no
empty state is not done.

## 10. What is deliberately NOT here

- No custom recommendation ML. Feed ranking is a documented SQL function, swappable.
- No AI dependency in any core path.
- No GitHub sync in MVP (schema has the columns; sync is a later module).
- No custom job queue. Scheduled work uses `pg_cron`.
- No Redis. Rate limiting is Postgres-backed, which is adequate at MVP scale and removes
  an entire piece of infrastructure.

## 11. Decisions

Recorded in [`docs/decisions/`](decisions/). Every non-obvious choice above has an ADR.
