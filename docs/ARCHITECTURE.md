# Architecture

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
> | `schema.ts` / `service.ts` per domain | `schemas.ts`, `queries.ts`, `actions.ts` | no `service.ts` yet — the two implemented domains are thin enough that a service layer would be a file with one function in it |
> | route groups `(marketing)`, `(auth)`, `(app)` | flat routes under `src/app/` | route groups get added when a group needs its own layout; two of them do not yet |
> | `lib/supabase/middleware.ts` | `proxy.ts` at the repo root | **Next 16 renamed `middleware.ts` to `proxy.ts`**; the logic lives there rather than in a helper |
> | ESLint `no-restricted-imports` enforces §3 | not configured | the four rules in §3 are followed by hand and are not yet mechanically enforced |
> | `revalidateTag('feed:${user.id}')` | `revalidatePath('/feed')` | see §4 |
> | `lib/rate-limit/` | does not exist | migration `0017_rate_limits` is unwritten |
> | Realtime (§4), Storage | not wired | no subscriptions, no buckets |
>
> Section 12 lists what exists per domain.

## 1. What this is

A **modular monolith**: one Next.js application, one Postgres database, hard internal
boundaries between domains. No microservices, no message bus, no Kubernetes. The
modularity is enforced by directory structure, import rules, and per-domain ownership of
tables — not by network hops.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | RSC lets reads happen server-side with no client bundle cost |
| Language | TypeScript, `strict` | non-negotiable for a schema this size |
| Styling | Tailwind CSS v4 | CSS-first config; tokens live in `globals.css` |
| Primitives | Radix UI via shadcn-style local components | accessible by default, we own the source |
| Database | Supabase Postgres | RLS is the security floor |
| Auth | Supabase Auth (email/password + Google OAuth) | cookie-based SSR sessions |
| Realtime | Supabase Realtime | chat + notifications, no polling — **not wired yet** |
| Storage | Supabase Storage | avatars, post media, attachments — **not wired yet** |
| Validation | Zod | one schema shared by client form, server action, and tests |
| Forms | React Hook Form + `zodResolver`, or `useActionState` | uncontrolled inputs, minimal re-render; the auth forms use `useActionState` because they post to Server Actions and must work without JS |
| Unit/integration | Vitest | fast, ESM-native |
| E2E | Playwright | real browser, real DB — **no specs written** |

### Next 16 notes that cost real debugging time

- `cookies()`, `headers()`, `params` and `searchParams` are **async**. Awaiting them is
  not optional.
- `middleware.ts` is now **`proxy.ts`**, exporting `proxy` rather than `middleware`.
- `next typegen` generates `PageProps<'/route'>` and `LayoutProps<'/'>` into
  `.next/types`. `tsc --noEmit` fails without it, which is why `npm run typecheck` runs
  typegen first.
- The proxy matcher **must** exclude `_next/static`, or an auth check runs in front of
  the stylesheet — and a redirect there does not fail loudly, it renders the site
  unstyled.
- A `'use server'` module may only export **async functions**. Exporting a plain object
  (a shared `emptyState` constant, say) throws at module evaluation. That is why
  `form-state.ts` files exist beside the `actions.ts` files.

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
service → revalidate → typed `Result<T>`. Errors become safe user-facing messages;
raw Postgres errors never reach the browser.

**Implemented today** without the wrapper (which does not exist yet), because the
wrapper's middleware — account status, rate limiting — has no database support yet:

```ts
export async function createPostAction(_prev: PostFormState, formData: FormData) {
  const parsed = postSchema.safeParse(...)          // Zod
  if (!parsed.success) return fieldErrors(parsed)
  const supabase = await createClient()             // runs AS THE USER, so RLS applies
  const { error } = await supabase.from('posts').insert({ ...parsed.data })
  if (error?.code === '42501') return { error: 'You are not allowed to post right now.' }
  if (error) return { error: GENERIC }              // never the Postgres message
  revalidatePath('/feed')
}
```

Note the insert carries **no `author_id`**: the column defaults to `auth.uid()` and a
trigger overwrites anything sent, so authorship cannot be forged even by a caller who
constructs the request by hand.

### Caching decision: `revalidatePath`, not tags — for now

`revalidateTag('feed:${user.id}')` is the design above, and it is wrong for
user-scoped data as things stand. A per-user tag needs a per-user cache entry, and the
feed is rendered dynamically per request because RLS makes every user's result
different. Tagging a response that is never reused buys nothing and creates a cache key
that must be invalidated correctly forever. `revalidatePath('/feed')` on the writer's
own request is honest about what is happening. Revisit when there is a genuinely shared,
cacheable read (a university directory, a public project page).

Also note: `revalidateTag` takes a single argument in Next 16.

### Realtime

`messages` and `notifications` only. Client subscribes to a filtered channel; RLS applies
to Realtime too, so a subscription cannot leak rows the user can't already read.

**Not wired.** There are no subscriptions in the codebase. Messaging has no UI.

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
- deduplication is a constraint rather than application logic that races.

**As built** (migration 0014), the entity reference is a set of **typed, nullable
foreign-key columns** — `post_id`, `project_id`, `idea_id`, `message_id`, … — with a
check constraint asserting that exactly one is non-null and that it matches the
`type`. The design above implied a polymorphic `(entity_type, entity_id)` pair. Typed
columns won for one reason: a polymorphic id has no referential integrity, so deleting
a post leaves a notification pointing at nothing, and every read has to defend against
it. With real foreign keys, `on delete cascade` removes the notification with the row
it refers to, and the database — not a query — guarantees the target exists.

The cost is a wider table and a migration whenever a new notifiable entity appears.
That is a good trade: adding a column is a decision someone reviews, which is what you
want when the question is "should this generate a notification".

Deduplication is `unique (recipient_id, actor_id, type, post_id, project_id, …) nulls
not distinct` — `nulls not distinct` is load-bearing, because without it every row with
a null column is unique and the constraint never fires.

## 9. Error and state contract

Every route that loads data ships four states: `loading.tsx` (or `<Suspense>` + skeleton),
error boundary, empty state, and content. This is checked in review — a route with no
empty state is not done.

`src/app/error.tsx` renders `error.digest` **only**, never `error.message`: in a Server
Component that message can contain a query, a path, or row data.

## 10. What is deliberately NOT here

- No custom recommendation ML. Feed ranking is a documented SQL function, swappable.
- No AI dependency in any core path.
- No GitHub sync in MVP (schema has the columns; sync is a later module).
- No custom job queue. Scheduled work uses `pg_cron`.
- No Redis. Rate limiting is Postgres-backed, which is adequate at MVP scale and removes
  an entire piece of infrastructure.

## 11. Decisions

The reasoning for each non-obvious choice is written **at the top of the file it
governs** — the migration headers and the module doc comments — rather than in a
separate ADR directory. `docs/decisions/` does not exist. That is a deliberate choice
for a codebase this young: a decision recorded next to the code it constrains is read
by the person about to change it; one filed in a directory is read by nobody. The
load-bearing ones are collected in [SECURITY.md](SECURITY.md) and in §2 above.

## 12. What exists today

The single source of truth is [`src/lib/build-status.ts`](../src/lib/build-status.ts),
which the running application renders at `/status`. It is code, not prose, so the
placeholder pages and the status page cannot disagree: `PlannedFeature` looks its own
state up in the same list.

| State | Meaning | Count |
| --- | --- | --- |
| `working` | usable end to end, once Supabase is configured | 5 |
| `partial` | real, incomplete — the gap is named on the page | 2 |
| `schema-only` | tables, policies and tests exist; **no interface** | 11 |
| `planned` | designed, not built; the route says so | 7 |

Per-domain: `auth` and `feed` have `schemas.ts` + `queries.ts` + `actions.ts` +
`components/`. Every other domain exists only as SQL. That asymmetry is the honest
picture of the project, and `/status` shows it to users rather than hiding it.
