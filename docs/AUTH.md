# Authentication

Supabase Auth, cookie sessions, four flows: email + password sign-up, sign-in, password
reset, and Google OAuth. All four are implemented. None has been exercised against a
live Supabase project — see [Verification](#verification).

---

## The pieces

| File | Role |
| --- | --- |
| `src/lib/supabase/client.ts` | browser client (`createBrowserClient`) |
| `src/lib/supabase/server.ts` | Server Component / Server Action client |
| `src/lib/supabase/admin.ts` | service-role client, `import 'server-only'` |
| `proxy.ts` | token refresh + route redirect |
| `src/features/auth/actions.ts` | the Server Actions |
| `src/features/auth/schemas.ts` | Zod schemas, shared by client and server |
| `src/features/auth/redirect.ts` | `?next=` validation |
| `src/app/auth/callback/route.ts` | OAuth / email-link code exchange |

## Why cookies, not `localStorage`

`@supabase/ssr` stores the session in cookies. Two reasons: a `localStorage` token is
readable by any injected script, and — more practically — Server Components cannot read
`localStorage`, so every page would have to render signed-out and then correct itself
on the client. Cookies make the server the source of truth.

## `getUser()`, never `getSession()`

`getSession()` decodes the cookie and returns what it says. It does not verify the
signature, so a hand-written cookie satisfies it. `getUser()` validates the token with
the auth server. Every authorization decision in this codebase uses `getUser()`.

The cost is a network call per request. That is the correct price.

## The proxy, and the cookie dance

Access tokens are short-lived and the refresh must happen somewhere that can write
cookies. Server Components cannot — their headers are already committed. So `proxy.ts`
calls `getUser()`, which performs the refresh, and the rewritten cookies ride out on
its response.

Inside `setAll` there are two writes and both are needed:

```ts
request.cookies.set(name, value)   // what the rest of THIS request reads
response.cookies.set(name, value)  // what the BROWSER stores
```

Setting only one produces a bug that looks like caching: the page renders signed-out,
and a refresh fixes it.

In `src/lib/supabase/server.ts` the same `setAll` is wrapped in try/catch, because a
Server Component throws when it writes a cookie. That is safe only because the proxy
already refreshed the session — the comment in the file says so, since the try/catch
looks like swallowing an error and is in fact relying on an earlier guarantee.

**The proxy's redirect is not a security boundary.** It spares a signed-out visitor an
empty page. A direct PostgREST call with the anon key never reaches it. RLS is what
protects data. Both statements are in the file's header comment.

Its matcher excludes `_next/static`, `_next/image` and image extensions. Without that
exclusion an auth check runs in front of the stylesheet, and a redirect there does not
fail loudly — it renders the site unstyled.

## Sign-up

1. Zod-validate email, password (12–72 chars), display name, and an accepted-terms
   checkbox — server-side, in the action, regardless of what the client did.
2. `signUp({ email, password, options: { data: { display_name }, emailRedirectTo } })`.
   The `data` payload is read by the `on_auth_user_created` trigger, which creates the
   `profiles` row in the same transaction as the auth user. No second request that can
   fail and leave an account with no profile.
3. The trigger assigns a placeholder username (`u` + 12 hex chars). Onboarding is where
   the user chooses a real one. **Not built yet** — a new account currently lands on a
   placeholder page.
4. Redirect to `/signup/check-email?email=…` — **always**, whether or not the address
   was already registered.

Why always: if an existing address produced a different response, the form would be an
account-enumeration oracle. Supabase sends an appropriate email either way.

The password ceiling of 72 is not arbitrary: bcrypt truncates at 72 bytes, so a longer
password would be silently trimmed. Rejecting it is honest; accepting it is not.

## Sign-in

Generic failure copy for every credential error — "Those details do not match an
account" — regardless of whether the email exists, the password is wrong, or the
account is unconfirmed. `describe()` maps known Supabase error codes to sentences and
logs the raw error server-side.

On success, redirect to `safeRedirect(next)`.

### `?next=` validation

An open redirect on a login page is a phishing primitive: the victim signs in on the
genuine domain, and the app hands them to `https://quad-login.example/`, which asks
them to sign in "again". Accepted only if the destination:

- is non-empty, and
- starts with `/`, and
- does not start with `//` (a browser reads that as a host) or `/\`, and
- contains no C0 control character or DEL.

Anything else falls back to `/feed`.

## Password reset

`resetPasswordForEmail` with a callback URL. The confirmation copy says "if an account
exists with that address" and is shown unconditionally. Only rate-limit errors are
surfaced verbatim — they are actionable and reveal nothing about whether the account
exists.

## Google OAuth

`signInWithOAuth({ provider: 'google', options: { redirectTo } })`, requesting **no
additional scopes**. The default grant is name, email and picture, which is all a
profile needs. Asking for more would be asking for permission to hold data the product
has no use for.

The button is a plain `<form>` posting to a Server Action, so it works without
JavaScript.

Enable the provider in the Supabase dashboard under **Authentication → Providers →
Google**, and add the callback to **URL configuration → Redirect URLs**.

## The callback route

`src/app/auth/callback/route.ts` handles both OAuth returns and email links:

| Condition | Result |
| --- | --- |
| provider sent `?error=` | `/login?error=<code>` — the `error_description` is never echoed, since it is attacker-influenced text rendered on our page |
| no `code` | `/login` |
| Supabase not configured | `/setup` |
| `exchangeCodeForSession` fails | `/login?error=link_expired` |
| success | `safeRedirect(next)` |

## Sign-out

`signOut({ scope: 'local' })`, as a **form**, not a link. A GET that changes state is
fetched by link prefetchers, browser previews and some security scanners — users would
be signed out by hovering over the menu.

`scope: 'local'` ends this session only. Signing out everywhere is a settings action,
not the default reading of "sign out" on the device in front of you.

## Route protection

Two layers, and the second is the one that counts:

1. `proxy.ts` redirects signed-out visitors away from `PRIVATE_PREFIXES`.
2. Each private page **re-checks** `getUser()` itself and redirects. `src/app/feed/page.tsx`
   does this with a comment explaining why the check is repeated: a page must not be
   correct only because of a file it does not import.

RLS is the third and real layer. Even with both checks removed, a signed-out request
sees only `public` rows.

## Verification

- **Verified:** schemas, redirect validation, error mapping and the flows compile,
  typecheck and lint; every auth route renders and returns the right status.
- **Not verified:** no live Supabase project has been connected. Sign-up, sign-in,
  reset, Google OAuth and the `on_auth_user_created` trigger firing on a real
  `auth.users` insert have not been run end to end. The trigger itself is tested against
  PGlite; the *Supabase Auth call that fires it* is not.
- **Not written:** Playwright specs for the auth flows.

## Not built

- Onboarding (choose username, university, programme) — placeholder page today.
- Email change, account deletion, session list, MFA.
- Rate limiting on Quad's own actions. Supabase rate-limits its auth endpoints; nothing
  limits posting.
