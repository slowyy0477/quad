# Environment variables

Bulla uses provider, local-mode, security and task-storage variables. The current
complete list and defaults are in `.env.example`; the table below describes the
hosted client/bootstrap subset. See [README](../README.md) for the private local
mode and [current setup gates](bulla/ISSUES.md) before a hosted deployment.

`.env.local` is git-ignored and must stay that way. Documents and
logs must never contain real keys or passwords. Legacy local demo credentials
are not production accounts and are not evidence of hosted security.

---

## The variables

| Variable | Required | Visibility | Used by |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase mode only | **public** — compiled into the browser bundle | every Supabase client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase mode only | **public** — compiled into the browser bundle | browser + server clients |
| `SUPABASE_SERVICE_ROLE_KEY` | privileged hosted code/scripts only | **secret** — must stay server-side | `scripts/create-admin.ts`, `src/lib/supabase/admin.ts` |
| `NEXT_PUBLIC_SITE_URL` | set explicitly for hosted production | public | OAuth redirects, metadata, proxy origin comparison |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | once, then delete | **secret** | `npm run create-admin` |

Find the first three in the Supabase dashboard under **Project settings → API**.

### Why two of them are public and that is fine

`NEXT_PUBLIC_*` variables are substituted into the JavaScript the browser downloads.
Anyone can read them with dev tools. The anon key is *designed* for that: it
identifies the project; access depends on the request's identity, explicit grants and
RLS. Public read policies intentionally allow anonymous reads in some domains.
There is no fixed table count or blanket “anon has no table grants” guarantee.

[`tests/db/schema.test.ts`](../tests/db/schema.test.ts) checks RLS/policies and function
audiences against the evolving migration catalog. That does not prove the deployed
schema, policies or hosted API behavior. An anon/publishable key is not a service-role
secret, but safe public use still requires correct deployed access controls.

### Why the service-role key must stay server-side

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security completely. With it, anyone
can read every private message on the platform. Three defences:

1. It has no `NEXT_PUBLIC_` prefix, avoiding intentional public-variable inlining.
2. `src/lib/env.ts` reads it through a function rather than the shared public schema.
3. `src/lib/supabase/admin.ts` uses `import 'server-only'` to reject imports across the
   client boundary.

Those are source defenses, not proof that an arbitrary build/log/response cannot leak
a secret. `next.config.ts` excludes app-owned credential/data paths from tracing, and
[`scripts/bulla/check-build.mjs`](../scripts/bulla/check-build.mjs) checks nonempty
artifact inventories using a fake secret marker. Actual passing evidence belongs in
[STATUS.md](bulla/STATUS.md); an empty-secret scan is not meaningful proof.
The existing [CI workflow](../.github/workflows/ci.yml) still permits that empty-value
skip; local verifier success does not close the R21 workflow gap.

Never paste this key into a chat message, an issue, a screenshot, or a log. If it
leaks, revoke/rotate the exposed credential using the project's supported process
and assess the exposure. Removing a value from source/logs alone does not revoke it.

---

## Setting up

Preserve an existing `.env.local`. Create one from the example only if it is
absent; on this Windows workspace:

```powershell
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
```

Then edit only the intended settings; do not overwrite unrelated credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
NEXT_PUBLIC_SITE_URL=
```

The service-role key is not required for ordinary user-facing hosted reads/writes;
only supply it to an explicitly authorized privileged workflow. The example is not
an instruction to put bootstrap credentials in every deployment.

`NEXT_PUBLIC_SITE_URL` can be left blank in development; it falls back to
`http://localhost:3000`. Restart the dev server after editing — Next reads env files
at startup, so an edit without a restart looks like the value was ignored.

Use **`/setup`** for selected-mode/configuration diagnostics, never as a connectivity,
email, upload or hosted-journey acceptance test. Presence and syntactic validity are
different from provider readiness; diagnostics must not print secret values.

## Private local mode versus Supabase

- `NEXT_PUBLIC_DATA_MODE=local` selects the JSON adapter. Other values select the
  Supabase path; merely setting cloud keys does not turn a local store into Postgres.
- `isDataConfigured()` accepts local mode without Supabase credentials.
  `isSupabaseConfigured()` only validates the public variable shapes; it makes no
  DNS, Auth, database or storage request.
- `LOCAL_DATA_PATH` selects the local store; the default remains `data/local.json`.
  Use an isolated fixture path for tests, never an owner's data. Local accounts,
  session identifiers and legacy sample data are preserved, not migrated by branding.
- In production, `src/proxy.ts` invokes the local-mode refusal. Only literal
  `BULLA_ALLOW_LOCAL_IN_PRODUCTION=1` (or its legacy `QUAD_*` fallback) permits an
  intentionally private preview. It is not permission to serve JSON accounts publicly
  or evidence of 50,000-user capacity.
- `BULLA_REQUIRE_HTTPS=1` opts into HTTPS-specific CSP/HSTS behavior; it does not
  provision a certificate or prove secure deployment. Keep local previews separate.

Test/cache/build and browser controls are separate from provider settings; their
current options are in `.env.example`, `scripts/bulla/verify.mjs`,
`vitest.config.ts` and `playwright.config.mts`. Preserve supported legacy `QUAD_*`
fallbacks and use the dedicated D-drive task folder for fixtures/evidence.

## Provider configuration is a separate boundary

[`supabase/config.toml`](../supabase/config.toml) configures the **local Supabase CLI
stack**, not the application's JSON adapter and not proof of a hosted project's
dashboard settings. Its Auth minimum, confirmation, password-change and TOTP settings
need reconciliation with the app's password policy (S09). Local SMTP capture,
Realtime/storage enable flags, pool settings and row caps do not prove hosted email
delivery, safe uploads, concurrency or capacity.

PGlite migration tests use their own platform-object shim; they do not launch this
CLI stack or exercise hosted PostgREST/Auth/Realtime. Hosted settings and real-session
negative tests must be recorded separately in the [current gates](bulla/ISSUES.md).

## What goes wrong when each is wrong

| Symptom | Cause |
| --- | --- |
| Hosted screens report setup required | public-variable validation failed; local-mode data screens do not require cloud credentials |
| `must be a full URL including https://` | the project *ref* was pasted instead of the URL |
| `must not end with a trailing slash` | URL-shape validation rejects the trailing `/`; use the expected canonical URL |
| `looks too short to be a Supabase key` | a truncated paste, or the project ref in the key field |
| Hosted sign-in bounces back to `/login` | investigate session cookies/refresh and provider errors; the proxy belongs at `src/proxy.ts`, beside `src/app`, with static assets excluded |
| Google sign-in returns to the wrong origin | `NEXT_PUBLIC_SITE_URL` wrong in production; the callback URL is built from it |
| `SUPABASE_SERVICE_ROLE_KEY is not set` | a privileged caller requested the admin client; ordinary user data paths should not require it |

Validation lives in [`src/lib/env.ts`](../src/lib/env.ts). It deliberately **does not
throw at import time** — a missing variable is a configuration state to render, not a
crash. If it threw, the page that explains what to configure would also fail.

The URL schema checks a valid absolute URL and no trailing slash; the `https://`
wording in an error is not proof that TLS is enforced. Key-length validation likewise
does not verify a credential with the provider.

## Production

Set the same variables in your host's dashboard (Vercel: Project → Settings →
Environment Variables). Two differences:

- Set `NEXT_PUBLIC_SITE_URL` explicitly to the intended public origin. It builds OAuth
  callbacks and the production proxy's origin comparison. This is a deployment
  requirement, not a strict missing-value rejection in `env.ts`: `siteUrl()` can fall
  back to Vercel host variables, then `http://localhost:3000`, even in production.
  Verify the actual redirect/origin behavior before launch.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` should **not** be set in the hosting environment at
  all. Use them only for an intentionally authorized hosted bootstrap, verify the
  target first and remove them afterwards. See [ADMIN.md](ADMIN.md) for the remaining
  bootstrap password/MFA gaps; this guide does not authorize a production run.

Add the callback URL to Supabase under **Authentication → URL configuration →
Redirect URLs**:

```
https://your-domain.example/auth/callback
```

Supabase-backed local development needs its actual callback origin (for example
`http://localhost:3000/auth/callback`) allowed on that provider. The private JSON
adapter has no local email recovery or Google identity integration.

## Not yet used

Do not confuse missing application integrations with provider or fixture code:

- No application analytics/error-reporting integration is established by the
  variables above. Supabase CLI analytics flags are not a Bulla production dashboard.
- Hosted Auth email-request code exists, but SMTP/provider delivery setup is separate
  and unverified. Local SMTP capture is not external delivery.
- `package.json` has no `npm run seed` command, but `src/lib/local/seed.ts` does
  initialize development fixtures. CLI seed configuration is a third, separate
  mechanism. Do not infer a safe hosted synthetic-data generator from any of these.

## Rotating a key

1. Confirm the chosen project's supported key-management/revocation process and the
   exact affected credential before acting.
2. Replace it in the relevant private operator/deployment environments without
   copying values into docs or evidence.
3. Rebuild/redeploy when a public key/URL changed: `NEXT_PUBLIC_*` values are compiled
   into client output. Verify the replacement and assess any prior exposure
   separately; no rotation is performed by this guide.
