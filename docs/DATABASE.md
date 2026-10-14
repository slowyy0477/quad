# Database

PostgreSQL, on Supabase. **17 migrations, 52 tables, 182 policies, 132 functions in the `app`
schema, ~10,500 lines of SQL.** The schema is the authorization layer, not a storage
detail — read [SECURITY.md](SECURITY.md) alongside this.

---

## Migration numbering

Numbers are reserved, not guessed. Docs drift most easily on this point — four documents
once named `0016_moderation`, `0017_rate_limits`, `0018_search` and `0020_storage`, while
the files that existed were `0016_backfill_profiles` and `0017_university_reference_data`.
The rule from here: **a number is reserved in the issue that will write it, and applied
migrations are never renumbered.**

| # | File | State |
| --- | --- | --- |
| 0001–0017 | extensions and helpers through university reference data | **applied** |
| 0018 | `0018_feed_ranking.sql` | reserved — feed ranking function (see `app.rank_feed`) |
| 0019 | `0019_search.sql` | reserved — search over people, projects, posts (trigram indexes exist) |
| 0020 | `0020_reports.sql` | reserved — reports, moderator actions, audit log (**launch blocker**) |
| 0021 | `0021_rate_limits.sql` | reserved — Postgres fixed-window limiter (**launch blocker**) |
| 0022 | `0022_storage.sql` | reserved — buckets, upload policies, MIME and size limits |

The next free number is **0023** once the reserved ones are written. If you are adding a
migration and your number is taken, take the next free one and update this table in the
same commit — this table is the only place the numbering is allowed to live.

---

## Applying it

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Migrations are ordinary, ordered SQL files in `supabase/migrations/`. They are applied
in filename order and are **not** idempotent by design: each one describes a change
from the previous state, which is what makes the sequence reviewable.

### Without the CLI

`db:push` needs the CLI logged in and the database password to hand. When that is a
wall — a first-time setup, a machine without the CLI — bundle the migrations into one
file and paste it into the dashboard's SQL editor instead:

```bash
npm run db:bundle
```

That writes `supabase/apply-all.sql` (git-ignored): every migration in order, wrapped
in one `begin`/`commit`, ending with the rows the CLI reads from
`supabase_migrations.schema_migrations` so a later `db push` does not try to re-run
them. DDL is transactional in Postgres, so it either all applies or none of it does —
there is no half-applied state to diagnose.

Once the schema is applied, that file will fail on its first `create table`. To apply
only what is outstanding:

```bash
node scripts/bundle-migrations.mjs --from 0016
```

### Checking it landed

```bash
npm run db:check
```

Read-only. It parses the expected table list out of `supabase/migrations/`, compares it
against what the project actually exposes, and confirms `anon` is refused on
`public.user_roles` — which proves the GRANT statements ran, not just the
`create table`s. An empty table returns an empty array either way, so "it returned no
rows" is not evidence.

Regenerate types after any schema change:

```bash
npm run db:types
```

## The migrations

| # | File | What it establishes |
| --- | --- | --- |
| 0001 | `extensions_and_helpers` | `citext`, `pg_trgm`; the `app` schema; `unique_slug`, `is_privileged_role`, `is_trusted_write`, `reject_protected_column_change`, `forbid_write`, `touch_updated_at` |
| 0002 | `roles` | `user_roles` (separate table, service-role-write-only); `app.is_admin`, `app.is_moderator`, `app.has_role` |
| 0003 | `universities` | universities, faculties, programmes; moderator-only writes |
| 0004 | `profiles` | `profiles`, `reserved_usernames`, the `on_auth_user_created` trigger, visibility columns |
| 0005 | `social_graph` | connections (request/accept/block), follows |
| 0006 | `skills_and_interests` | skills, interests, endorsements, user-declared levels |
| 0007 | `projects` | projects, members, roles, invitations, collaboration requests |
| 0008 | `posts` | posts, comments, likes, counter triggers |
| 0009 | `ideas` | ideas, idea interest, idea→project conversion |
| 0010 | `messaging` | conversations, participants, messages, read state |
| 0011 | `learning` | courses, learning entries, goals, semesters, study logs |
| 0012 | `achievements` | achievements, certificates, awards |
| 0013 | `opportunities_events` | opportunity and event boards, applications, RSVPs |
| 0014 | `notifications` | typed-FK notifications with a non-forgeable write path |
| 0015 | `function_grants` | the grant correction described in SECURITY.md §3 |
| 0016 | `backfill_profiles` | a profile row for any auth user created before 0004's trigger existed |

0016 is the one migration that is deliberately idempotent, because it repairs data
rather than describing a schema change. It exists because the order people really do
first-time setup in is *create project → sign up to check the form → apply migrations*,
and the trigger that creates profiles only fires for auth users inserted after it
exists. The user left behind can sign in and has no profile: signed in and unusable at
once, which is more confusing to debug than being locked out.

### Planned, not written

`0017_moderation`, `0018_rate_limits`, `0019_search`, `0020_feed`, `0021_storage`,
`0022_analytics`. Their absence is why the corresponding features read
**schema-only** or **planned** on `/status`.

## Conventions

**Naming.** `snake_case`, plural tables, singular columns. Timestamps are
`timestamptz` and end in `_at`. Booleans read as assertions (`is_`, `has_`).
Soft deletes are `deleted_at timestamptz`, never a boolean.

**Primary keys** are `uuid default gen_random_uuid()`, except join tables which use a
composite key of their two FKs — that makes the uniqueness constraint the key rather
than an afterthought.

**Foreign keys** always declare `on delete`. Choosing between `cascade`,
`set null` and `restrict` is a product decision (does the child mean anything without
the parent?) and is made per column, not by habit.

**`security definer` functions** always `set search_path = ''` and schema-qualify every
reference. Without that, a caller can prepend a schema to `search_path` and have the
function resolve `posts` to a table they control.

**Denormalised counters** (`like_count`, `comment_count`, `member_count`) exist because
`count(*)` over a feed does not scale. They are maintained by triggers, ungranted to
clients, and zeroed on client insert. They are the only place the schema stores a
derived value.

## The `app` schema

132 functions live in `app`, and none of them is reachable over HTTP: PostgREST serves
only `public` and `graphql_public`. That is the point — `app` is where the guards live,
so they cannot be called or probed by a client, only invoked by triggers and policies.

Client-callable RPCs go in `public` and are granted explicitly to `authenticated`.

## Testing

`tests/db/` runs the **real migration files** against PostgreSQL 18 in WASM
(PGlite) — not a mock, not a subset. 292 assertions across 8 files. See
[TESTING.md](TESTING.md).

The harness (`tests/db/harness.ts`) applies every migration in order, then lets a test
impersonate a role by setting `request.jwt.claims` and `role` the way PostgREST does,
so a test exercises the same code path a browser request does.

Two invariant tests are worth naming:

- **Every table has RLS enabled and at least one policy.** Adding a table without
  policies fails the suite.
- **Every function's EXECUTE grants match its declared audience.** Adding a function
  fails the suite until someone decides who may call it.

## Local development without Docker

Supabase's local stack needs Docker. If you do not have it — this project was developed
without it — use a hosted project for the app and PGlite for tests. The migrations are
identical; only `supabase start` is unavailable. `npm test` needs no Docker and no
network.

## Backups

Supabase takes daily backups on paid plans and none on the free tier. Before any
production launch, confirm the plan, confirm the retention, and **restore one backup
into a scratch project** — an untested backup is a hope, not a backup.
