/**
 * Grant the first admin (or moderator) role.
 *
 *   npm run create-admin
 *   npm run create-admin -- --role moderator
 *
 * There is no hard-coded password in this file and there must never be one. The
 * credentials come from ADMIN_EMAIL and ADMIN_PASSWORD in `.env.local`, which is
 * git-ignored, and the recommended flow is: set them, run this once, delete them
 * from the file again. The password is sent to Supabase Auth, which stores only an
 * argon2/bcrypt hash — this script never writes it anywhere, never logs it, and
 * cannot read it back afterwards. Nor can an admin: there is no code path in this
 * repository that reads a user's password, because the database does not hold one.
 *
 * Why a script and not a UI: `public.user_roles` has no INSERT grant for `anon` or
 * `authenticated`, and a `before insert` trigger blocks writes on top of that. Only
 * the service role can grant a role, and the service key never leaves the server.
 * That means there is no "make me an admin" request an attacker can forge, and no
 * first-run page that is a privilege-escalation hole until someone claims it.
 *
 * Run it against whichever project `.env.local` points at. Check that before you
 * run it against production.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'

const ROLES = ['admin', 'moderator'] as const
type Role = (typeof ROLES)[number]

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

/** `.env.local` wins over `.env`, matching Next's own precedence. */
function loadEnvironment() {
  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file)
    if (existsSync(path)) loadEnv({ path, quiet: true })
  }
}

function parseRole(argv: string[]): Role {
  const index = argv.indexOf('--role')
  if (index === -1) return 'admin'

  const value = argv[index + 1]
  if (!value || !ROLES.includes(value as Role)) {
    fail(`--role must be one of: ${ROLES.join(', ')}`)
  }
  return value as Role
}

async function main() {
  loadEnvironment()

  const role = parseRole(process.argv.slice(2))

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD

  if (!url) fail('NEXT_PUBLIC_SUPABASE_URL is not set. See docs/ENVIRONMENT.md.')
  if (!serviceKey) fail('SUPABASE_SERVICE_ROLE_KEY is not set. See docs/ENVIRONMENT.md.')
  if (!email) fail('ADMIN_EMAIL is not set. Add it to .env.local.')
  if (!password) fail('ADMIN_PASSWORD is not set. Add it to .env.local.')

  // Same rule as the sign-up form, applied here too. A weak admin password is a
  // worse problem than a weak user password, and the form's validation is not on
  // this path.
  if (password.length < 12) {
    fail('ADMIN_PASSWORD must be at least 12 characters.')
  }

  // Printed so nobody grants themselves admin on the wrong project by accident.
  // The host, never the key.
  console.log(`\n  Project: ${new URL(url).host}`)
  console.log(`  Account: ${email}`)
  console.log(`  Role:    ${role}\n`)

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Create the account, or find it if it already exists. `email_confirm: true`
  // because there is nobody to click a confirmation link for a bootstrap account.
  let userId: string | undefined

  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (created.error) {
    const alreadyExists =
      created.error.code === 'email_exists' ||
      created.error.message.toLowerCase().includes('already been registered')

    if (!alreadyExists) fail(`Could not create the account: ${created.error.message}`)

    console.log('  Account already exists; granting the role to it.')

    // listUsers is paginated; the bootstrap admin is normally on page one, but
    // walk the pages rather than assume it.
    for (let page = 1; page <= 20 && !userId; page += 1) {
      const listed = await supabase.auth.admin.listUsers({ page, perPage: 200 })
      if (listed.error) fail(`Could not list users: ${listed.error.message}`)
      userId = listed.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id
      if (listed.data.users.length < 200) break
    }

    if (!userId) fail(`Supabase reports ${email} exists but it was not found in the user list.`)
  } else {
    userId = created.data.user?.id
    if (!userId) fail('Supabase created the account but returned no id.')
    console.log('  Account created.')
  }

  // The profile row comes from the on_auth_user_created trigger, so it exists by
  // now. Roles live in their own table precisely so that a user updating their own
  // profile cannot touch this. See supabase/migrations/0002_roles.sql.
  const granted = await supabase
    .from('user_roles')
    .upsert({ user_id: userId, role, note: 'Bootstrapped by scripts/create-admin.ts' }, {
      onConflict: 'user_id,role',
    })

  if (granted.error) fail(`Could not grant the role: ${granted.error.message}`)

  console.log(`  ✓ ${email} now holds the ${role} role.\n`)
  console.log('  Next: remove ADMIN_EMAIL and ADMIN_PASSWORD from .env.local, and')
  console.log('  sign in normally. Change the password after first sign-in.\n')
}

main().catch((error: unknown) => {
  // No stack-trace dump: the message is enough, and a trace through the Supabase
  // client has been known to include request detail.
  fail(error instanceof Error ? error.message : String(error))
})
