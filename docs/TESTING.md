# Testing

```bash
npm test          # everything
npm run verify    # typecheck + lint + test  ← run this before pushing
```

Current state, measured — not estimated:

```
Test Files  8 passed (8)
     Tests  296 passed (296)
  Duration  ~84s
```

All 296 are **database permission tests**. That is a deliberate order of work, not an
oversight: the database is the authorization layer, so it is the layer where a missing
test is a vulnerability rather than a bug.

---

## What is tested

| Suite | Assertions | Covers |
| --- | --- | --- |
| `tests/db/schema.test.ts` | 17 | Invariants: every table has RLS + a policy; every function's EXECUTE grants match its declared audience; the 0016 profile backfill |
| `tests/db/guards.test.ts` | 14 | `is_privileged_role`, `is_trusted_write`, protected-column rejection, `forbid_write` |
| `tests/db/projects.test.ts` | 33 | Project membership, roles, invitations, collaboration requests |
| `tests/db/messaging.test.ts` | 34 | Conversation access — the ID-substitution cases in particular |
| `tests/db/learning.test.ts` | 53 | Courses, entries, goals, semesters, study logs |
| `tests/db/achievements.test.ts` | 34 | Achievements, certificates, awards |
| `tests/db/opportunities.test.ts` | 34 | Boards, applications, RSVPs |
| `tests/db/notifications.test.ts` | 77 | Typed-FK integrity and the non-forgeable write path |

## How the database tests work

`tests/db/harness.ts` starts **PGlite** — PostgreSQL 18.3 compiled to WASM — and applies
the real files from `supabase/migrations/` in order. Not a mock, not a fixture, not a
subset. If a migration is malformed, the suite fails to start.

It then lets a test impersonate a role the way PostgREST does:

```ts
await asUser(alice, async (db) => {
  await expect(db.query('select * from messages where conversation_id = $1', [bobsChat]))
    .rejects.toThrow()          // or resolves to zero rows, per the policy
})
```

Setting `request.jwt.claims` and `role` is exactly what PostgREST does per request, so a
test exercises the same code path a browser does — including
`app.is_privileged_role()`, which reads both of those signals.

Two consequences worth knowing:

- **No Docker required.** The Supabase local stack needs it; this does not. This project
  was developed on a machine without Docker.
- **`timestamptz` comes back as a `Date`.** Use `toEqual`, not `toBe`.

### The shape every permission test takes

Each protected operation is asserted from **three** directions, because only the third
is a real test:

1. the owner can do it,
2. an unrelated user cannot,
3. an unrelated user cannot do it **by substituting an ID** — which is what an attacker
   actually tries.

Case 3 is why `messaging.test.ts` is as long as it is. "Users must not be able to read
another user's private conversation by manipulating IDs" is a requirement, so it is a
test, not a comment.

### Invariant tests

Two tests exist to fail on *future* work:

- Add a table without RLS or without a policy → `schema.test.ts` fails.
- Add a function without deciding who may execute it → `schema.test.ts` fails.

The second one caught the real bug documented in [SECURITY.md](SECURITY.md) §3: Supabase's
default privileges grant `EXECUTE` directly to `anon`/`authenticated`, and
`revoke … from public` does not remove that.

## What is NOT tested

Listed plainly, because a coverage number that hides this would be worse than no number:

| Area | State |
| --- | --- |
| Profiles, universities, social graph, skills, posts, comments, ideas | **Schema built, permission tests not written.** The largest gap. |
| React components | No tests. Testing Library is installed and configured; nothing is written. |
| Server Actions | No tests. |
| Zod schemas | No tests. |
| `safeRedirect` | No tests — and it should have them; it is 6 lines of pure function guarding a phishing vector. |
| End-to-end flows | **No Playwright specs.** `@playwright/test` is installed, `npm run test:e2e` is wired, `tests/e2e/` is empty. |
| Anything against a live Supabase project | Nothing. No credentials have been supplied. |
| Accessibility | No automated checks. Primitives were built to be accessible (`Field` wires `aria-describedby`/`aria-invalid` through a render prop so it cannot drift); that is design, not verification. |
| Performance | No measurements. |

`tests/integration/` and `tests/security/` exist as empty directories — placeholders for
the suites the structure anticipates.

## Adding a database test

```ts
import { describe, expect, it } from 'vitest'
import { withDatabase } from './harness'

describe('widgets', () => {
  it('lets the owner update, and nobody else', async () => {
    await withDatabase(async (db, { alice, bob }) => {
      // ...
    })
  })
})
```

Keep the three-direction shape. A test that only proves the happy path proves the
feature works, not that it is safe.

## Conventions

- Vitest, with `vite-tsconfig-paths` so `@/` resolves.
- Test names state the rule, not the mechanism: "a non-member cannot read a private
  project", not "test policy 4".
- The database suite is slow (~84s) because each file boots a Postgres. That is
  acceptable for a suite that runs on push; do not optimise it by sharing state between
  tests, which would make failures order-dependent.
