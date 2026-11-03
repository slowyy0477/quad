# Testing

```bash
npm test          # Vitest: permissions, local actions/security, unit/components
npm run verify    # typecheck + lint + Vitest (not build/browser/hosted acceptance)
npm run verify:bulla -- --build --e2e   # D-drive Markdown evidence + local checks
```

Current results belong in [bulla/STATUS.md](bulla/STATUS.md) and timestamped
verification reports, not a frozen count in this guide. The recovery verifier
stores synthetic fixtures, cache/build output and reports under
`D:\All tasks + Automations\Bulla-Recovery` on this Windows workspace.

Ordinary Vitest runs can select `BULLA_TEST_TMP_DIR` and `BULLA_TEST_CACHE_DIR`.
Browser specs use a separate loopback server and isolated data. Never point
them at an owner's data server or a production endpoint.

---

## What is tested

This is a source inventory, not a claim that every feature or provider journey is
covered. Passing/failing totals belong in the canonical status and evidence JSON.

| Suite / source examples | Covers |
| --- | --- |
| [`tests/db/schema.test.ts`](../tests/db/schema.test.ts), `guards.test.ts` | Ordered migrations, public-table RLS/policies, helper privileges/search paths, protected columns, profile trigger/backfill |
| [`tests/db/people.test.ts`](../tests/db/people.test.ts), `posts.test.ts`, `ideas.test.ts` | Profiles, universities, graph/skills, posts/comments and ideas permissions |
| [`tests/db/projects.test.ts`](../tests/db/projects.test.ts), `messaging.test.ts` | Membership, roles, invitations and conversation access/ID substitution |
| `tests/db/learning.test.ts`, `achievements.test.ts`, `opportunities.test.ts` | Learning records, awards, boards/applications and RSVPs |
| [`tests/db/notifications.test.ts`](../tests/db/notifications.test.ts), `moderation.test.ts`, `authorization-regressions.test.ts` | Notification writes, reporting/staff decisions/audit/sanctions, limiter boundaries and forward authorization fixes |
| [`tests/integration/`](../tests/integration/) | Local profile/onboarding persistence and schemas, real local domain actions, timed-suspension regressions |
| [`tests/security/`](../tests/security/) | Local auth/session/password/redirect/store guards, mocked hosted-settings ownership, proxy/headers, PWA and artifact-check behavior |
| [`src/components/pwa-controls.test.tsx`](../src/components/pwa-controls.test.tsx), [`attached-object.test.tsx`](../src/features/feed/components/attached-object.test.tsx), other `src/**/*.test.*` | Selected React controls and pure helpers, including mode/env/cursors, dates and board filters |
| [`tests/e2e/bulla-smoke.spec.ts`](../tests/e2e/bulla-smoke.spec.ts) | Isolated local identity/header, signed-out, responsive/theme and signup→onboard→edit→post/reload→sign-out smoke |

## How the database tests work

[`tests/db/harness.ts`](../tests/db/harness.ts) starts **PGlite** — an in-process
PostgreSQL build compiled to WASM — applies the platform-object shim in
[`supabase/tests/bootstrap.sql`](../supabase/tests/bootstrap.sql), then the real
files from `supabase/migrations/` in filename order. The SQL is real; the shim is
not a running Supabase service stack. A malformed migration fails setup.

It then lets a test select a PostgreSQL role/JWT subject. Illustrative use of the
actual harness API, after creating fixture users and conversations:

```ts
const rows = await db.asUser(
  alice,
  'select * from messages where conversation_id = $1',
  [bobsChat],
)
expect(rows).toEqual([]) // SELECT may filter to no rows rather than throw.
```

Setting `request.jwt.claims` and `role` exercises the SQL policy/function code,
including `app.is_privileged_role()`. It does not emulate all of PostgREST or
verify real tokens, Auth, HTTP errors, publication delivery or independent
transaction concurrency. Those require separate integration/staging evidence.

Each PGlite instance reuses one SQL session; serial role-switched calls are not
independent transaction-concurrency evidence. Local JSON locking tests are a
different contract again. Playwright owns `tests/e2e`; Vitest intentionally excludes
those browser specs. See [`vitest.config.ts`](../vitest.config.ts) and
[`playwright.config.mts`](../playwright.config.mts).

Two consequences worth knowing:

- **No Docker required for PGlite tests.** This does not mean the Supabase CLI stack
  or its Auth/PostgREST/Realtime services were exercised.
- **`timestamptz` comes back as a `Date`.** Use `toEqual`, not `toBe`.

### The shape every permission test takes

The permission-test contract calls for **three** directions; review coverage rather
than assuming every operation already has all three:

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

## Remaining coverage and evidence gaps

Existing tests do not establish complete browser/provider/security acceptance:

| Area | State |
| --- | --- |
| Components/actions/schemas | Selected component tests, local actions and auth/profile schema regressions exist; they are not comprehensive coverage of every action or form. |
| Redirect validation | `local-auth-policy.test.ts` and `local-auth.test.ts` cover the hardened local redirect and action redirects. Hosted `safeRedirect` is a separate implementation; local coverage does not prove hosted parity or encoded-input handling. |
| Browser journeys | Local Playwright smoke exists. Complete two-account permissions, all domains, provider/email/OAuth/recovery and multi-device journeys remain. |
| Hosted Supabase | Auth, HTTP/PostgREST errors, RLS via the real API, Realtime, storage and independent transactions require staging evidence. Current gates are in [ISSUES.md](bulla/ISSUES.md); this guide makes no current credential or DNS claim. |
| CI parity | The existing [workflow](../.github/workflows/ci.yml) can skip its secret scan when the value is empty and has no browser job (R21). The local verifier's nonempty-canary and browser checks do not establish CI parity. |
| Accessibility | Selected control and viewport/theme assertions exist. Full automated/manual WCAG, keyboard, screen-reader and device acceptance is pending. |
| Performance/recovery | Test duration or a successful local build is not load/soak, query-plan, backup/restore or 50,000-account evidence. See [PLAN.md](bulla/PLAN.md). |

`tests/integration/` and `tests/security/` contain real suites, not empty placeholders.
“Integration” in those paths includes local adapters and mocked clients; the name
does not mean a hosted project was contacted.

## Adding a database test

Illustrative skeleton using the current harness; add fixtures, legitimate writes,
negative reads/writes and ID-substitution assertions for the domain:

```ts
import { describe, expect, it } from 'vitest'
import { createTestDb } from './harness'

describe('widgets', () => {
  it('lets the owner update, and nobody else', async () => {
    const db = await createTestDb()
    try {
      const alice = await db.createUser()
      const bob = await db.createUser()
      expect(alice).not.toBe(bob)
      // Add domain fixtures and permission assertions via db.asUser().
    } finally {
      await db.close()
    }
  })
})
```

Keep the three-direction shape. A test that only proves the happy path proves the
feature works, not that it is safe.

## Conventions

- Vitest, with `vite-tsconfig-paths` so `@/` resolves.
- Test names state the rule, not the mechanism: "a non-member cannot read a private
  project", not "test policy 4".
- Database files create isolated PGlite instances; local suites use owned temporary
  workspaces. Do not trade fixture isolation for speed. Runtime and totals vary by
  checkout/environment and belong in timestamped reports.
- The recovery verifier is a one-off command, not a recurring schedule. Run only one
  at a time; a passing local report does not establish hosted acceptance.
