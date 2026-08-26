/**
 * Check a live Supabase project against the migrations in this repository.
 *
 *   npm run db:check
 *
 * The database test suite (`npm test`) proves the migrations are correct by
 * applying them to a throwaway Postgres. It says nothing about whether they were
 * applied to *your* project, or applied completely. This closes that gap, which
 * is otherwise checked by clicking around the dashboard and counting tables by
 * eye.
 *
 * Read-only. It creates nothing, writes nothing, and deletes nothing.
 *
 * Three checks:
 *
 *   1. Every `create table public.x` in supabase/migrations exists in the
 *      project. The expected list is parsed from the migration files rather than
 *      hard-coded, so it cannot go stale.
 *
 *   2. `anon` is refused on public.user_roles. That table is granted to
 *      `authenticated` only, so a refusal proves the GRANT statements ran -- not
 *      just the CREATE TABLEs. An empty result would not prove it: an empty table
 *      returns an empty array whether the grants applied or not.
 *
 *   3. The service role can read a table, confirming the key works.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) loadEnv({ path, quiet: true })
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey) {
  console.error('\n  NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.\n')
  process.exit(1)
}

const pass = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  console.log(`  ✗ ${m}`)
  failures += 1
}
let failures = 0

// --- expected tables, parsed from the migrations -----------------------------

const MIGRATIONS_DIR = 'supabase/migrations'
const expected = new Set()

for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
  for (const match of sql.matchAll(/^create table (?:if not exists )?public\.(\w+)/gim)) {
    expected.add(match[1])
  }
}

console.log(`\n  Project:  ${new URL(url).host}`)
console.log(`  Expected: ${expected.size} tables from ${MIGRATIONS_DIR}\n`)

// --- 1. do the tables exist? -------------------------------------------------
//
// PostgREST publishes an OpenAPI document at the API root listing everything it
// exposes. One request, rather than one request per table.

const root = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: serviceKey ?? anonKey, Authorization: `Bearer ${serviceKey ?? anonKey}` },
})

if (!root.ok) {
  fail(`Could not reach the API (HTTP ${root.status}). Check the URL and keys.`)
} else {
  const spec = await root.json()
  const exposed = new Set(Object.keys(spec.definitions ?? spec.components?.schemas ?? {}))
  const missing = [...expected].filter((t) => !exposed.has(t))

  if (missing.length === 0) {
    pass(`All ${expected.size} tables exist`)
  } else {
    fail(`${missing.length} of ${expected.size} tables are missing:`)
    for (const t of missing) console.log(`      - ${t}`)
    console.log('\n      The schema is not fully applied. Run `npm run db:push`, or paste')
    console.log('      supabase/apply-all.sql into the Supabase SQL editor.\n')
  }
}

// --- 2. is anon actually refused where it should be? -------------------------

const asAnon = await fetch(`${url}/rest/v1/user_roles?select=user_id&limit=1`, {
  headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
})

if (asAnon.ok) {
  fail('anon can read public.user_roles — the GRANT statements did not apply')
  console.log('      This table must be readable by `authenticated` only.')
} else {
  pass(`anon is refused on public.user_roles (HTTP ${asAnon.status}) — grants applied`)
}

// --- 3. does the service key work? -------------------------------------------

if (!serviceKey) {
  console.log('  - SUPABASE_SERVICE_ROLE_KEY not set, skipping service-role check')
} else {
  const asService = await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (asService.ok) {
    const rows = await asService.json()
    pass(`Service role can read public.profiles (${rows.length} row${rows.length === 1 ? '' : 's'})`)
  } else {
    fail(`Service role was refused on public.profiles (HTTP ${asService.status})`)
  }
}

console.log(
  failures === 0
    ? '\n  Database looks correctly set up.\n'
    : `\n  ${failures} check${failures === 1 ? '' : 's'} failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
