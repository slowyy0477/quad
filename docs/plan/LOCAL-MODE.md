# Local mode

The site runs against a JSON file on this machine. Supabase is still the target
deployment and its code is intact — it is simply not selected.

```
NEXT_PUBLIC_DATA_MODE=local     # data/local.json, no network
NEXT_PUBLIC_DATA_MODE=supabase  # the real thing
```

`src/lib/mode.ts` holds the switch. A production build in local mode refuses to start
unless `QUAD_ALLOW_LOCAL_IN_PRODUCTION=1`, because local mode has no row-level security,
no rate limiting and no verified identity.

---

## The demo account

```
email    demo@quad.local
password quad-demo-2026
```

The seed writes five accounts, six posts, three projects, three ideas, five
notifications, a semester with four courses and three goals, five days of study log,
two events and three opportunities. It runs once, on the first request, and lives in
`data/local.json` (git-ignored).

---

## What is real, and what is not

| | Supabase (target) | Local mode (now) |
|---|---|---|
| Passwords | GoTrue, bcrypt | scrypt, salted, per-account |
| Session | signed JWT, refreshed by `proxy.ts` | HMAC over the user id, `httpOnly` cookie, 30 days |
| Authorisation | row-level security in Postgres | TypeScript checks in each action |
| Rate limiting | `app.check_rate_limit` ledger | none |
| Email | Supabase mail | none — no confirmation, no reset |
| Realtime | Realtime service | polling only (not wired) |
| Deletes | soft, with triggers | soft by convention |

The interface says "Local mode" in the header on every page. It is not a warning to be
dismissed; it is the truth about this deployment.

---

## The store API

`src/lib/local/db.ts`

```ts
readStore()            // the whole store, cached per process
mutate(fn)             // fn(db) => result; the file is written afterwards, serialised
id('pst')              // a new id
now()                  // ISO timestamp
```

Table types are exported: `LocalProfile`, `LocalPost`, `LocalProject`, `LocalIdea`,
`LocalNotification`, `LocalMessage`, `LocalGoal`, `LocalMilestone`, `LocalLog`,
`LocalOpportunity`, `LocalEvent`, `LocalUniversity`, and so on.

`src/lib/local/session.ts`

```ts
getLocalUser()         // { id, email, profile } | null, from the signed cookie
createAccount({...})   // { user, profile } | null when the email is taken
checkCredentials()     // user | null
startSession/endSession()
hashPassword/verifyPassword
```

`src/lib/local/seed.ts` — `ensureSeeded()`, `reseed()`, `DEMO_EMAIL`, `DEMO_PASSWORD`.

---

## How to port a domain

A domain is ported when its `queries.ts` and `actions.ts` read and write the store
**instead of** Supabase, while returning exactly the shapes they return today — the
components must not need to change.

1. Read the existing `queries.ts`. Every exported function and its return type stays.
2. Replace `const supabase = await createClient()` with `const db = await readStore()`.
3. Filter in TypeScript. The volumes are tiny; clarity beats a query language here.
4. **Visibility is not optional.** Reproduce, in TypeScript, what the Postgres policy
   does. The rule lives in the migration header; copy it into a comment and implement it
   literally. The local mode equivalent of "RLS refuses the row" is "the row is filtered
   out before it reaches the shape".
5. Derive counters from the arrays (`like_count`, `comment_count`, `member_count`,
   `attendee_count`, `milestone_count`) rather than trusting the stored number — the
   stored number is a cache, and in local mode there is no trigger maintaining it.
6. Writes go through `mutate`, return the same `FormState`/result shape, and call
   `revalidatePath` exactly as before.
7. Delete nothing from the Supabase path: keep it behind `if (!isLocalMode())` so the
   deployment still works when the project exists.

**Definition of done for a ported domain:** `npx tsc --noEmit` clean for the files
touched, `npx eslint <touched paths>` clean, and the route renders content with the demo
account signed in.
