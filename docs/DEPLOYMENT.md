# Deployment

**Read this first: Quad is not ready for a public launch.** It can be deployed — the
build is clean and the database layer is solid — but the launch checklist at the bottom
has unticked items that are not cosmetic. Deploy it to a preview URL, share it with
people who know what they are looking at, and treat the checklist as the gate for
anything more.

---

## What you need

| Account | For | Cost |
| --- | --- | --- |
| [Supabase](https://supabase.com) | Postgres, Auth, Storage | free tier is enough to start |
| [Vercel](https://vercel.com) (or any Node host) | the Next.js app | free tier is enough to start |
| [Google Cloud Console](https://console.cloud.google.com) | Google sign-in — **optional**; email/password works without it | free |
| A domain | production only | varies |

No other third-party service is used. No analytics, no error reporting, no email
provider beyond Supabase's own — see [PRIVACY](../src/app/privacy/page.tsx), which says
the same thing to users.

## 1. Database

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Verify in the dashboard: **Table editor** shows 52 tables, and every one has the RLS
shield lit. If any table shows RLS disabled, stop — that table is world-readable with
the public anon key. (`npm test` asserts this, so it should not happen; check anyway,
because this is the failure that matters most.)

Then, in **Project settings → Database**:

- Note whether your plan includes backups. The free tier does not.
- Before real users exist, restore one backup into a scratch project. An untested
  backup is not a backup.

## 2. Auth configuration

**Authentication → URL configuration:**

```
Site URL:       https://your-domain.example
Redirect URLs:  https://your-domain.example/auth/callback
                http://localhost:3000/auth/callback
```

**Authentication → Providers → Email:** confirm "Confirm email" is on. The sign-up flow
assumes it.

**Authentication → Providers → Google** (optional): paste the client ID and secret from
Google Cloud Console. In Google Cloud, the authorised redirect URI is Supabase's, not
yours:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

Request no scopes beyond the default profile ones.

## 3. Environment variables

Set these in your host's dashboard. Full reference: [ENVIRONMENT.md](ENVIRONMENT.md).

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

`NEXT_PUBLIC_SITE_URL` is **required** in production: the OAuth callback URL is built
from it, and a wrong value sends a user and their authorization code to another origin.

Do **not** set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the hosting environment. They are
read by a local script; see [ADMIN.md](ADMIN.md).

## 4. Deploy

Vercel detects Next.js with no configuration:

```bash
npm i -g vercel
vercel
vercel --prod
```

Any Node host works:

```bash
npm ci
npm run build
npm start
```

Node ≥ 20.9. The anon key is compiled into the client bundle at build time, so rotating
it requires a **rebuild**, not a restart.

## 5. First admin

Once, from your machine, with `.env.local` pointing at the production project:

```bash
npm run create-admin
```

Then delete the credentials from `.env.local`. See [ADMIN.md](ADMIN.md).

## 6. Verify the deployment

Check each of these by hand; there is no automated smoke test yet.

- [ ] `/` renders, and shows **no** "Setup required" badge
- [ ] `/setup` reports all four variables present
- [ ] `/status` loads
- [ ] Sign up with a real address → the confirmation email arrives → the link returns to
      the site signed in
- [ ] Sign in, sign out, sign in again
- [ ] Password reset email arrives and works
- [ ] Google sign-in, if enabled
- [ ] Post to the feed; confirm the row exists in the Table editor with the right
      `author_id`
- [ ] Sign out and hit `/feed` → redirected to `/login`
- [ ] Open dev tools → Network → confirm no request carries the service-role key
- [ ] View source → search the bundle for the service key → **must not appear**

The last two are the ones to do properly.

---

## Production launch checklist

Unticked items are not ready. This is the honest state, not a wish list.

### Blocking — must be done before real users

- [ ] **Legal review.** `/terms` and `/privacy` are drafts and say so on the page. A
      lawyer must review them. Do not remove the warning banners to make the site look
      finished.
- [ ] **Remove `robots: { index: false }`** from `src/app/layout.tsx` — but only when the
      rest of this list is done. A half-built site in search results is harder to undo
      than to prevent.
- [ ] **Moderation.** Migration `0016_moderation` is not written. There is no way to
      report content, no moderator queue, and no audit log. Do not open a social
      platform to strangers without these.
- [ ] **Rate limiting.** `0017_rate_limits` is not written. Nothing limits how fast a
      user can post.
- [ ] **A security contact.** [SECURITY.md](SECURITY.md) §9 has no address.
- [ ] **Backups verified by restore.**
- [ ] **Onboarding.** New accounts get a placeholder username and no way to set a real
      one.

### Important

- [ ] Content Security Policy and security headers (`next.config.ts` — nothing configured)
- [ ] Playwright end-to-end specs (`tests/e2e/` is empty)
- [ ] Permission tests for profiles, social graph, posts, comments, ideas
- [ ] Error reporting (Sentry or equivalent — none)
- [ ] Uptime monitoring
- [ ] Accessibility audit with a screen reader
- [ ] Lighthouse pass on mobile
- [ ] A custom domain, so the auth cookie is on a domain you control

### Before announcing

- [ ] Every feature marked `planned` or `schema-only` on `/status` is either built or
      still honestly labelled. **Do not remove the status page to look finished** — it is
      the thing that keeps the product honest with its users.
- [ ] No seed or test accounts in the production database. There is no seed script yet,
      so today this means: check for accounts you created while testing.
- [ ] Confirm the "under construction" copy still matches reality.

## Rollback

Vercel keeps previous deployments; promote an earlier one from the dashboard.

Database migrations do **not** roll back. There is no down-migration in this project,
deliberately — a down-migration that has never been run is a false sense of safety. To
undo a schema change, write a new forward migration. Take a snapshot before
`db:push` on anything with real data in it.
