# Administration

Two privileged roles exist in the database: `admin` and `moderator`. The **database
side is built and tested**. The **admin interface is not built** — `/admin` is gated in
`proxy.ts` and has no pages. Everything below that describes a screen is marked as such.

---

## Creating the first admin

```bash
npm run create-admin
```

Reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env.local`, creates the account through
Supabase Auth (which stores only a hash), and inserts a row in `public.user_roles`.

Then **delete both variables from `.env.local`** and change the password after first
sign-in.

To grant a moderator role instead:

```bash
npm run create-admin -- --role moderator
```

The script prints the project host and the account email before acting, so you cannot
grant yourself admin on the wrong project without noticing.

### There is no hard-coded password

There is none in this repository and there must never be one. The credentials come from
a git-ignored env file, are used once, and are then removed. The script never writes the
password anywhere, never logs it, and cannot read it back.

### Why a script and not a first-run page

`public.user_roles` has **no** `INSERT` grant for `anon` or `authenticated`, and an
`app.forbid_write()` trigger blocks writes on top of that. Only the service role can
grant a role, and the service key never leaves the server.

That means there is no "make me an admin" request an attacker can forge, and no
first-run page that is a privilege-escalation hole until someone claims it. Roles also
live in their own table rather than on `profiles`, because a user who can update their
own profile row can update every granted column of it — see
[SECURITY.md](SECURITY.md) §4.

## What admins can and cannot see

**Cannot, and this is not a policy — it is an absence:**

- **Passwords.** Supabase Auth stores a hash. There is no code path in this repository
  that reads a password, because there is nothing to read. An admin who wants a user's
  password has to ask them, like anyone else.
- **Private messages.** No admin or moderator policy grants read access to
  `public.messages`. The planned `0016_moderation` migration adds one narrow policy: a
  moderator may read a message **that has been reported**, and only that message. Until
  that migration exists, nobody can read anyone's messages through the application at
  all.
- **Private profile fields** of users who set them private, and **draft** content.

**Can:**

- Read every row in `user_roles` (policy `user_roles_select_admin`).
- Write university, faculty and programme records — moderator-or-above, enforced by
  `app.is_privileged_role() or app.is_moderator()` guards in migration 0003.

Anyone with the **service-role key** bypasses all of this. That is the definition of the
key, which is why it must never reach a browser and why its handling is documented in
[ENVIRONMENT.md](ENVIRONMENT.md). The privacy page tells users this in plain language.

## Checking who holds a role

In the Supabase SQL editor:

```sql
select ur.role, ur.granted_at, p.username, p.display_name
from public.user_roles ur
join public.profiles p on p.id = ur.user_id
order by ur.role, ur.granted_at;
```

## Revoking a role

```sql
delete from public.user_roles where user_id = '<uuid>' and role = 'admin';
```

Run as the service role (the SQL editor is). The `forbid_write` trigger allows it
because `app.is_privileged_role()` is true there and false for every client request.

## Not built

Stated plainly so nothing here is mistaken for a working feature:

| | State |
| --- | --- |
| `/admin` pages | **None.** The route is gated and empty. |
| Moderation queue | Not built. `0016_moderation` unwritten. |
| Content reports | Not built — users cannot report anything. |
| Bug reports | Not built. `/report-a-bug` is a placeholder. |
| Audit log | Not built. Designed as append-only with `forbid_write`. |
| User suspension / bans | Not built. No `suspended` state exists. |
| Analytics dashboard | Not built. `0021_analytics` unwritten. There are no platform statistics anywhere in the UI, real or otherwise. |
| Role management UI | Not built. Use the script and SQL above. |

When `/admin` does get pages, every one must re-check `app.is_admin()` **server-side**.
The `proxy.ts` check is a convenience: a request that never reaches the proxy is still
a request. "A normal user must not access admin routes" is enforced by the database or
it is not enforced.

## Operational notes

- **Deleting a user:** delete from Supabase Auth (dashboard → Authentication → Users).
  Foreign keys cascade from `auth.users`, so the profile and owned rows follow. Check
  what `on delete` says for each table first — some are `set null` deliberately, so
  content survives its author.
- **There is no seed script.** `npm run seed` was removed rather than left pointing at a
  file that does not exist. Any future one must refuse to run against a non-localhost
  project and must label its rows visibly, so seed data can never be mistaken for real
  users.
