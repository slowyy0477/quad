# Authentication

Bulla has hosted Supabase Auth code and a separate private local adapter.
Signup/sign-in, onboarding and OAuth/recovery-request screens/actions exist;
they are not complete hosted acceptance. Password-reset completion currently
targets the missing `/settings/password` route. See [current status](bulla/STATUS.md)
and [account/security gates](bulla/ISSUES.md). The older design notes below are
not evidence that a real hosted flow passed.

---

## The pieces

| File | Role |
| --- | --- |
| `src/lib/supabase/client.ts` | browser client (`createBrowserClient`) |
| `src/lib/supabase/server.ts` | Server Component / Server Action client |
| `src/lib/supabase/admin.ts` | service-role client, `import 'server-only'` |
| `src/proxy.ts` | token refresh, route redirects, origin/CSP/private-mode guards |
| `src/features/auth/actions.ts` | the Server Actions |
| `src/features/auth/schemas.ts` | Zod schemas, shared by client and server |
| `src/features/auth/redirect.ts` | `?next=` validation |
| `src/app/auth/callback/route.ts` | OAuth / email-link code exchange |
| `src/features/auth/local-actions.ts` | separate local signup/sign-in/sign-out |
| `src/lib/local/session.ts`, `auth-security.ts` | opaque local sessions, account availability, local throttling/redirect checks |
| `src/app/onboarding/page.tsx`, `src/features/profiles/actions.ts` | onboarding UI and provider-specific profile persistence |

## Why cookies, not `localStorage`

The hosted path uses `@supabase/ssr` cookies so Server Components and actions can
resolve the session; they cannot read browser `localStorage`. Cookies alone are not
an XSS defense or proof of `HttpOnly` settings. The local adapter explicitly sets an
`HttpOnly`, same-site cookie and resolves it through its private session store.

## `getUser()`, never `getSession()`

Hosted authorization code calls `supabase.auth.getUser()` rather than treating
cookie/session contents as a verified identity. The shared
[`getUser` helper](../src/lib/supabase/server.ts) is request-memoized for Server
Components, not cached across users.

In local mode the helper calls [`getLocalUser`](../src/lib/local/session.ts):
random opaque tokens resolve through stored SHA-256 digests, expiry and account
availability checks. That is a separate local contract, not a hosted JWT/Auth test.

## The proxy, and the cookie dance

The hosted branch of [`src/proxy.ts`](../src/proxy.ts) calls `getUser()` through the
SSR client and handles refreshed cookies where response headers can be written.
Its location is beside `src/app`, not at the repository root. Local mode instead
checks the private-production guard and continues to page/action session checks;
it does not run Supabase refresh or the hosted route-redirect branch.

Inside `setAll` there are two writes and both are needed:

```ts
request.cookies.set(name, value)   // what the rest of THIS request reads
response.cookies.set(name, value)  // what the BROWSER stores
```

Setting only one produces a bug that looks like caching: the page renders signed-out,
and a refresh fixes it.

In `src/lib/supabase/server.ts`, `setAll` catches cookie-write failures from Server
Component contexts and relies on the proxy's refresh path. Correct refresh/redirect
cookie behavior still needs a real hosted expiry/replay journey; this source pattern
is not evidence that it has passed.

**The proxy's redirect is not a security boundary.** It spares a signed-out visitor an
empty page. A direct PostgREST call with the anon key never reaches it. RLS is what
protects data. Both statements are in the file's header comment.

Its matcher excludes `_next/static`, `_next/image` and image extensions. Without that
exclusion an auth check runs in front of the stylesheet, and a redirect there does not
fail loudly — it renders the site unstyled.

## Sign-up

1. Zod-validate email, the current signup password policy, display name and an accepted-terms
   checkbox — server-side, in the action, regardless of what the client did.
2. `signUp({ email, password, options: { data: { display_name }, emailRedirectTo } })`.
   The `data` payload is read by the `on_auth_user_created` trigger, which creates the
   `profiles` row in the same transaction as the auth user. No second request that can
   fail and leave an account with no profile.
3. The trigger assigns a placeholder username (`u` + 12 hex chars). Onboarding is where
   the user chooses a real one. The
   [onboarding page](../src/app/onboarding/page.tsx) and
   [profile actions](../src/features/profiles/actions.ts) exist; this is not a placeholder.
4. If Supabase returns a session, redirect immediately to `/onboarding`. Otherwise
   a successful response goes to `/signup/check-email?email=…`. Error responses are
   mapped separately.

New signup uses a 15-character minimum, a 128-character ceiling and checks for
trivial/common passwords in [`schemas.ts`](../src/features/auth/schemas.ts).
Sign-in deliberately accepts shorter legacy passwords. This is not a claim about
the hosted provider's hashing or direct-client policy: the repository CLI config has
a weaker minimum and confirmation/MFA disabled, while the actual hosted settings
remain [S09 acceptance work](bulla/ISSUES.md).

The no-session success branch uses neutral copy, but the code can surface an
existing-account error depending on provider configuration. Local signup also
reports a duplicate email. Do not describe every branch as enumeration-resistant.

Local signup validates through the shared schema, creates the user/profile in one
locked store mutation, sets onboarding incomplete, starts a local session and redirects
to `/onboarding`. It has no email-confirmation step. Initial publication choice and
complete hosted onboarding acceptance remain unfinished.

## Sign-in

Invalid email/password credentials use generic failure copy. Some other hosted error
codes have distinct messages, including email confirmation required; `describe()`
maps them to user-facing sentences and logs details server-side.

Hosted success redirects to `safeRedirect(next)`. Local actions use the separate,
more restrictive `safeLocalRedirect(next)` and local attempt budgets.

### `?next=` validation

An open redirect on a login page is a phishing primitive: the victim signs in on the
genuine domain, and the app hands them to `https://bulla-login.example/`, which asks
them to sign in "again". Accepted only if the destination:

- is non-empty, and
- starts with `/`, and
- does not start with `//` (a browser reads that as a host) or `/\`, and
- contains no C0 control character or DEL.

Anything else falls back to `/feed`.

[`local-auth-policy.test.ts`](../tests/security/local-auth-policy.test.ts) covers
local decoding/control-character defenses. That is not dedicated hosted
`safeRedirect` parity coverage; the implementations must be reviewed separately.

## Password reset

The hosted request action calls `resetPasswordForEmail` with
`/auth/callback?next=/settings/password`. Rate-limit failures are mapped to user copy;
other provider outcomes use the neutral sent screen.

**Completion is missing (S08).** There is no `/settings/password` page or completed
password-update action. `newPasswordSchema` alone is not a recovery flow. Recovery
session verification, expiry/reuse rejection, changing the password and revoking old
sessions remain unimplemented acceptance work. No local email-recovery path exists.

## Google OAuth

The hosted action uses
`signInWithOAuth({ provider: 'google', options: { redirectTo } })` with **no additional
scopes requested by the application**. Provider setup, consent and returned identity
data still need hosted verification. There is no local Google identity integration.

The button is a plain `<form>` posting to a Server Action, so it works without
JavaScript.

Configure the provider and permitted callback URLs on the intended hosted project.
Application variables or local CLI settings do not establish that configuration.

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

`scope: 'local'` requests sign-out for this hosted session. Local sign-out revokes the
current opaque session before clearing its cookie. Neither is a built all-devices
session-management screen.

## Route protection

Two layers, and the second is the one that counts:

1. The hosted branch of `src/proxy.ts` redirects signed-out visitors away from
   `PRIVATE_PREFIXES`; local mode does not use that branch.
2. Private pages/actions must independently resolve the session and check access.
   [`feed/page.tsx`](../src/app/feed/page.tsx) is one such page check.

Hosted RLS/grants protect direct Data API access independently of redirects.
Local adapter checks are different and must be tested as such; a local session does
not prove hosted Auth, RLS or Realtime protection.

## Verification

- **Local evidence:** opaque sessions, local actions/profiles, password policy and
  suspension regressions; exact passing/failing results are in the Bulla records.
- **Hosted acceptance pending:** sign-up, sign-in,
  reset, Google OAuth and the `on_auth_user_created` trigger firing on a real
  `auth.users` insert have not been run end to end. The trigger itself is tested against
  PGlite; the *Supabase Auth call that fires it* is not.
- **Browser coverage:** isolated local smoke specs exist; complete two-account,
  provider, email/OAuth/reset and multi-device journeys remain.

## Present, partial and missing

| Area | Current scope / remaining |
| --- | --- |
| Signup/sign-in/sign-out | Hosted actions and private local equivalents exist; provider and multi-device acceptance remain. |
| Onboarding | UI/actions and local persistence tests exist; initial publication choice and hosted acceptance remain. |
| Password recovery | Hosted email-request/callback code only; `/settings/password` completion is missing (S08). No local email recovery. |
| Privacy/profile editing | Real owner-scoped actions exist; this is not email/password or account-lifecycle management. |
| Email change, export/deletion, session list, staff MFA | No completed application flows; see S09/S10 and the current plan. |
| Abuse controls | Selected hosted action buckets and local auth throttles exist; mandatory direct-write/multi-instance budgets remain S06. |

A provider Auth rate limit is not a general content-abuse control, and a source file
or passing local test is not hosted acceptance.
