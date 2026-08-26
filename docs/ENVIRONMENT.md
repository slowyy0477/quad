# Environment variables

Four variables, one of which is a secret. This document says what each one is for,
where to find it, who is allowed to see it, and what breaks when it is wrong.

`.env.local` is git-ignored and must stay that way. Nothing in this document, and
nothing in this repository, contains a real key or a password.

---

## The variables

| Variable | Required | Visibility | Used by |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | **public** — compiled into the browser bundle | every Supabase client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | **public** — compiled into the browser bundle | browser + server clients |
| `SUPABASE_SERVICE_ROLE_KEY` | admin scripts only | **secret** — server only, never in a bundle | `scripts/create-admin.ts`, `src/lib/supabase/admin.ts` |
| `NEXT_PUBLIC_SITE_URL` | in production | public | OAuth redirect URLs, `metadataBase` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | once, then delete | **secret** | `npm run create-admin` |

Find the first three in the Supabase dashboard under **Project settings → API**.

### Why two of them are public and that is fine

`NEXT_PUBLIC_*` variables are substituted into the JavaScript the browser downloads.
Anyone can read them with dev tools. The anon key is *designed* for that: it
identifies the project and carries the `anon` Postgres role, nothing more. It is safe
only because every one of the 52 tables has row-level security with explicit policies
and table grants revoked from `anon`. If RLS were disabled on a single table, the anon
key would become a public read of that table — which is exactly why
`tests/db/schema.test.ts` fails when a table exists without RLS.

### Why the fourth must never be public

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security completely. With it, anyone
can read every private message on the platform. Three defences:

1. It has no `NEXT_PUBLIC_` prefix, so the bundler never substitutes it.
2. `src/lib/env.ts` reads it inside a function rather than at module scope, so the
   string does not appear in any module the bundler might follow into a client chunk.
3. `src/lib/supabase/admin.ts` starts with `import 'server-only'`. If any module
   reachable from a Client Component imports it, **the build fails** instead of
   shipping the key. That is a build-time assertion, not a convention.

Never paste this key into a chat message, an issue, a screenshot, or a log. If it
leaks, rotate it in the dashboard immediately — a leaked service key is a full
database compromise, and rotating is the only fix.

---

## Setting up

```bash
cp .env.example .env.local
```

Then fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
NEXT_PUBLIC_SITE_URL=
```

`NEXT_PUBLIC_SITE_URL` can be left blank in development; it falls back to
`http://localhost:3000`. Restart the dev server after editing — Next reads env files
at startup, so an edit without a restart looks like the value was ignored.

Check the result at **`/setup`**. It reports each variable as present or absent and
lists what is wrong. It deliberately never prints a value: setup pages get
screenshotted into chat windows.

## What goes wrong when each is wrong

| Symptom | Cause |
| --- | --- |
| "Setup required" badge in the header; every form disabled | one of the two required public variables is missing or malformed |
| `must be a full URL including https://` | the project *ref* was pasted instead of the URL |
| `must not end with a trailing slash` | trailing `/` — it produces `//rest/v1/...` and 404s |
| `looks too short to be a Supabase key` | a truncated paste, or the project ref in the key field |
| Sign-in appears to work, then bounces back to `/login` | cookies not being set — check that `proxy.ts` is present and its matcher excludes `_next/static` |
| Google sign-in returns to the wrong origin | `NEXT_PUBLIC_SITE_URL` wrong in production; the callback URL is built from it |
| `SUPABASE_SERVICE_ROLE_KEY is not set` | only reachable from admin scripts; the app itself never needs it |

Validation lives in [`src/lib/env.ts`](../src/lib/env.ts). It deliberately **does not
throw at import time** — a missing variable is a configuration state to render, not a
crash. If it threw, the page that explains what to configure would also fail.

## Production

Set the same variables in your host's dashboard (Vercel: Project → Settings →
Environment Variables). Two differences:

- `NEXT_PUBLIC_SITE_URL` becomes **required**. It builds the OAuth callback URL, and a
  wrong value sends a user — and their authorization code — to another origin.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` should **not** be set in the hosting environment at
  all. They are read by a local script; put them in `.env.local`, run
  `npm run create-admin` once against the production project, then delete them.

Add the callback URL to Supabase under **Authentication → URL configuration →
Redirect URLs**:

```
https://your-domain.example/auth/callback
```

Local development needs `http://localhost:3000/auth/callback` in the same list.

## Not yet used

These appear in no code path today; they are listed so nobody sets them expecting an
effect:

- Analytics, error-reporting and email-provider keys — none of those integrations
  exist yet.
- A seed-data variable. There is no seed script; `npm run seed` was removed rather
  than left pointing at a file that does not exist. When one is written it will create
  data that is visibly labelled as seed data and refuse to run against a project whose
  URL is not localhost.

## Rotating a key

1. Supabase dashboard → **Project settings → API → Rotate**.
2. Update `.env.local` and every deployment environment.
3. Redeploy. The anon key is baked into the client bundle at build time, so a rotated
   anon key needs a rebuild, not just a restart.
