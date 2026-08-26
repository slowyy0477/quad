# Security

The premise of this document: **the interface is not a permission system.** Hiding a
button prevents nothing, because a client can talk to PostgREST directly with the
public anon key and never load the application at all. So every access-control
decision in Quad is made in Postgres, and this document is a record of how — written
so that the reasoning survives the person who wrote it.

Status: the database layer described here is built and tested (292 assertions).
Sections marked **not built** describe an intended design that does not exist yet.
Nothing here has been exercised against a hosted Supabase project.

---

## 1. Threat model

Assumed capable of anything: **any holder of the anon key**, which is everybody. It is
compiled into the browser bundle by design.

| Adversary | Can do | Must not be able to |
| --- | --- | --- |
| Anonymous visitor | Any HTTP request; direct PostgREST calls; call any function granted to `anon` | Read anything not explicitly public; enumerate users; discover whether an email is registered |
| Signed-in user | Everything above, plus authenticated reads/writes; craft any request body; substitute any UUID | Read another user's private conversation, private profile fields, or draft; write a column the server owns; grant themselves a role; act as another user |
| Moderator | Everything above, plus moderation reads/writes | Read private messages that have not been reported; act unaudited |
| Admin | Full application privilege | See any user's password (none exists to see); escape the audit log |
| Service-role key holder | Everything, RLS bypassed | — this is why the key must never reach a browser |

Out of scope and stated honestly: DDoS, Supabase-platform compromise, a compromised
developer machine, and physical access.

## 2. Where authorization lives

Four layers, listed inner to outer. Each is independent; each assumes the others might
be missing.

### 2.1 Table-level grants

RLS decides *which rows*. Grants decide *which columns and operations*. Both are used,
because a policy that permits `update … using (author_id = auth.uid())` permits
updating **every column of that row**, including ones the server owns.

So every table follows this shape:

```sql
revoke all on table public.posts from anon, authenticated;
grant select on table public.posts to anon, authenticated;
grant insert (body, visibility, ...) on table public.posts to authenticated;
grant update (body, visibility, edited_at)  on table public.posts to authenticated;
```

`moderation_status`, `like_count`, `comment_count`, `author_id` are simply not in the
grant list. A request that tries to set one gets `42501 permission denied for column`
from Postgres — not from a check someone remembered to write.

The rule this produced, stated once: **a column the client must not control is not
granted, not merely un-rendered.**

### 2.2 Row-level security

Enabled on all 52 tables, with explicit policies per operation and per role. There is
no table with RLS enabled and no policy (which denies everything, usually by accident)
and no table without RLS (which permits everything).

`tests/db/schema.test.ts` enumerates `pg_class` and fails on either condition. That
test is the reason a future migration cannot forget.

Visibility is modelled as four levels, evaluated in SQL:

| Level | Who can read |
| --- | --- |
| `public` | anyone, including anonymous |
| `university` | signed-in users whose `university_id` matches the author's |
| `connections` | accepted connections of the author |
| `private` | the author only |

The application does **not** re-implement this filter in TypeScript. `getFeedPosts()`
selects without a visibility clause, deliberately, with a comment saying why: a second
copy of an authorization rule can only drift from the first, and when it drifts the
weaker copy wins.

### 2.3 Trigger guards

Some invariants cannot be expressed as a grant or a policy. Those are `before` triggers
in `security definer` functions.

- **Ownership forcing** — `author_id`/`owner_id`/`user_id` are set to `auth.uid()` on
  insert, ignoring whatever the client sent. Combined with the missing grant, forging
  authorship fails twice.
- **Protected columns** — `app.reject_protected_column_change(...)` raises if a client
  statement changes a column the schema owns.
- **Append-only tables** — `app.forbid_write()` on `user_roles` and the audit log.
- **Counter integrity** — denormalised counts (`like_count`, `member_count`) are
  maintained by triggers and zeroed on client insert.

**The rule discovered the hard way:** a protected-column list must not include a
column that a trigger itself derives *and* the client legitimately reads back. Adding
one makes every ordinary update fail at depth 1 while passing in tests that write at
depth > 1. `app.is_trusted_write()` exists for exactly this: `pg_trigger_depth() > 1`
means the write came from the schema's own code, not from a request.

### 2.4 `app.is_privileged_role()` — the one to read carefully

Guards need to distinguish "a browser client did this" from "a migration or the service
role did this". The obvious test is wrong in the dangerous direction:

```sql
-- WRONG. Inside a SECURITY DEFINER function, current_user is the function OWNER.
current_user in ('postgres', 'service_role')
```

Nearly every guard here lives in a `security definer` trigger, so a `current_user`
test reports *privileged* for every ordinary user and silently skips the defence it
was written to apply. `session_user` is no better — PostgREST connects as
`authenticator` and then `SET ROLE`s.

So the decision is made from request context, and requires **two independent signals**
to agree:

1. the verified JWT `role` claim, which PostgREST sets from the signed token and which
   SQL inside a request cannot rewrite; and
2. the `role` GUC, reflecting the `SET ROLE` PostgREST issued, which `security definer`
   does not disturb.

Requiring both makes it fail closed. See `supabase/migrations/0001_extensions_and_helpers.sql:161`.

Related three-valued-logic trap, also load-bearing: `current_setting(x, true)` returns
`NULL` when unset, and `false or null` is `NULL`, so `if not f() then …` **skips its
body** — silently disabling the guard. Every GUC read is `coalesce`d.

## 3. Function grants: the correction in 0015

PostgreSQL grants `EXECUTE` on a new function to `PUBLIC` by default, so every
restricted function ended with `revoke execute … from public`. On Supabase that is
necessary and **not sufficient** — Supabase also configures:

```sql
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
```

Revoking from `PUBLIC` does not remove a direct grant to a role. So functions intended
to be service-role-only stayed callable by every signed-in user.
`public.dispatch_due_reminders()` was the sharp case: callable by any user, and its
return value counted notifications generated for other people.

**The rule, from here on:** a function's grant block names every role it revokes from.
It never relies on `from public` to remove a grant that was made to a role.

Enforced by an invariant test that enumerates every function in `public` and `app` and
fails if one is executable by a role not on its allow-list. Adding a function fails the
suite until the audience is declared — that failure is the feature.

## 4. Privilege escalation: why roles are a separate table

`user_roles` is its own table, deliberately **not** a column on `profiles`.

Users must be able to update their own profile. Any policy permitting that permits
writing every granted column of that row. If `role` lived on `profiles`, then

```sql
update profiles set role = 'admin' where id = auth.uid();
```

would be a one-line escalation that passes RLS. Instead: no `INSERT`/`UPDATE`/`DELETE`
grant to `anon` or `authenticated` at all, plus `app.forbid_write()` as a second
barrier. Roles are assigned only by the service role, via
[`scripts/create-admin.ts`](../scripts/create-admin.ts).

## 5. Authentication

Full detail in [AUTH.md](AUTH.md). The security-relevant points:

- **`getUser()`, never `getSession()`.** `getSession()` decodes the cookie without
  verifying it, so a forged cookie satisfies it. `getUser()` validates against the
  auth server.
- **Sessions in cookies, not `localStorage`** (`@supabase/ssr`), so a token is not
  readable by injected script and is available to Server Components.
- **`proxy.ts` is convenience, not a boundary.** It refreshes tokens (Server Components
  cannot write cookies) and redirects signed-out visitors away from private routes. Its
  redirect protects nothing: a direct PostgREST call skips it entirely. Both facts are
  written in the file so nobody mistakes it for the security layer.
- **Passwords** are never stored, logged, or read by this codebase. Supabase Auth holds
  a hash. There is no code path — including admin paths — that can display one, because
  there is nothing to display. Minimum 12 characters, maximum 72 (bcrypt truncates
  beyond that, so a longer password would be silently trimmed rather than rejected).
- **Open-redirect defence** on `?next=`: a destination is accepted only if it starts
  with a single `/`, and is rejected for `//host`, `/\host`, and any C0/DEL control
  character. An open redirect on a login page is a phishing primitive — the victim
  signs in on the genuine domain and is then handed to an attacker's copy.
  ([`src/features/auth/redirect.ts`](../src/features/auth/redirect.ts))
- **Account-enumeration defence:** sign-in failures are one generic message; sign-up
  lands on the same "check your email" page whether or not the address existed; the
  reset flow says "if an account exists". Rate-limit errors are the only auth errors
  surfaced verbatim, because those are actionable and reveal nothing.
- **Sign-out is a form, not a link.** A GET that changes state gets fetched by link
  prefetchers and browser previews — people would be signed out by hovering.

## 6. Secrets

| | Handling |
| --- | --- |
| Anon key | Public by design. Safe only because RLS holds. |
| Service-role key | No `NEXT_PUBLIC_` prefix; read inside a function rather than at module scope; the only module that uses it starts with `import 'server-only'`, so a client-reachable import **fails the build** instead of shipping it. |
| Admin bootstrap password | Env var, used once, then deleted. There is no hard-coded password anywhere in this repository, and there must never be one. |

`/setup` reports env vars as present/absent and never prints a value — configuration
pages get screenshotted into chat windows.

## 7. Error handling

Users get sentences; logs get detail. `describe()` in the auth actions switches over
known Supabase error codes and returns plain copy, logging the raw error server-side.
Database errors are never forwarded: `42501` becomes "You are not allowed to do that",
everything else becomes a generic failure.

`src/app/error.tsx` renders `error.digest` only — never `error.message`, which in a
Server Component can contain a query, a path, or a row.

## 8. Not built yet — do not assume these protections exist

Stated explicitly so nobody reads this document as a description of a finished system:

- **Rate limiting.** Supabase Auth rate-limits its own endpoints; Quad's own actions
  (posting, messaging, reporting) have none. Migration `0017_rate_limits` is planned.
- **Uploads.** No storage buckets, no MIME/extension/size validation, no upload path at
  all. Planned as `0020_storage`. Until then there is no upload to attack.
- **Moderation and audit.** `0016_moderation` — reports, bug reports, an append-only
  admin audit log, and the narrow policy letting a moderator read a *reported* message
  and nothing else — is designed but not written. Today no moderator can read any
  private message, which is the safe end of that trade.
- **Admin routes.** `/admin` is gated in `proxy.ts` and has no pages. When it gets
  pages, every one must re-check `app.is_admin()` server-side; the proxy check is not
  the boundary.
- **CSP and security headers.** Not configured. Next's defaults only.
- **Automated dependency scanning.** Not configured.
- **Penetration testing.** None performed.

## 9. Reporting a vulnerability

There is no published contact yet; the project is not deployed. Before any public
launch this section must name a real address and a response commitment — see the
launch checklist in [DEPLOYMENT.md](DEPLOYMENT.md).
