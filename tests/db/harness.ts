/**
 * Database test harness.
 *
 * Boots a real Postgres (PGlite -- Postgres 18 compiled to WebAssembly), applies
 * the Supabase platform shim, then applies every migration in
 * `supabase/migrations/` in filename order. Tests then run statements as `anon`,
 * as a specific authenticated user, or as `service_role`.
 *
 * Why not the Supabase CLI: it requires Docker, which is not available in this
 * environment. See supabase/tests/bootstrap.sql for what this does and does not
 * prove.
 *
 * The important property: `asUser()` switches the Postgres role to
 * `authenticated` and sets the JWT `sub` claim, so RLS policies and column-level
 * GRANTs are evaluated exactly as they would be for a browser request arriving
 * through PostgREST. A test that passes here is testing the real policy, not a
 * simulation of it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations')
const BOOTSTRAP_PATH = join(REPO_ROOT, 'supabase', 'tests', 'bootstrap.sql')

export type TestDb = {
  raw: PGlite
  /** Run SQL as the given user id, with the `authenticated` Postgres role. */
  asUser: <T = Record<string, unknown>>(
    userId: string,
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>
  /** Run SQL as an unauthenticated visitor (`anon` role, no JWT claim). */
  asAnon: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>
  /** Run SQL with full privileges. Use only for fixtures, never for assertions. */
  asService: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>
  /** Create a published synthetic fixture; raw signup tests insert auth.users directly. */
  createUser: (opts?: CreateUserOpts) => Promise<string>
  close: () => Promise<void>
}

export type CreateUserOpts = {
  email?: string
  fullName?: string
  /** Set the profile username directly, skipping the onboarding flow. */
  username?: string
  universityId?: string
  /** Fixture consent defaults to public, not the production signup default. */
  visibility?: 'public' | 'university' | 'connections' | 'private'
  role?: 'admin' | 'moderator'
}

let cachedMigrations: { name: string; sql: string }[] | null = null
let cachedBootstrap: string | null = null

async function loadSql() {
  if (!cachedBootstrap) {
    cachedBootstrap = await readFile(BOOTSTRAP_PATH, 'utf8')
  }
  if (!cachedMigrations) {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    cachedMigrations = await Promise.all(
      files.map(async (name) => ({
        name,
        sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8'),
      })),
    )
  }
  return { bootstrap: cachedBootstrap, migrations: cachedMigrations }
}

/**
 * Boot a fresh database with the full schema applied.
 *
 * Each call is a brand-new in-memory instance, so tests cannot leak state into
 * one another. Boot takes roughly a second, which is cheap enough to do per
 * test file and worth far more than the shared-fixture bugs it prevents.
 */
export async function createTestDb(): Promise<TestDb> {
  const { bootstrap, migrations } = await loadSql()

  const pg = await PGlite.create({ extensions: { pg_trgm, btree_gin } })

  await pg.exec(bootstrap)

  for (const migration of migrations) {
    try {
      await pg.exec(migration.sql)
    } catch (error) {
      // Name the file. A bare "syntax error at or near" with twenty migrations
      // applied is close to useless.
      throw new Error(
        `Migration failed: ${migration.name}\n${(error as Error).message}`,
      )
    }
  }

  let userSeq = 0
  // Existing staff-domain scenarios intentionally use already-verified fixture
  // operators with an explicitly enrolled synthetic factor. Raw claim tests
  // independently exercise no-factor state, AAL1, expiry and revocation.
  // This affects only the synthetic DB, never production authentication.
  const verifiedStaffFixtures = new Set<string>()
  const staffFixtureSessions = new Map<string, string>()

  const runAs = async <T>(
    role: 'anon' | 'authenticated' | 'service',
    userId: string | null,
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    // reset first: PGlite reuses one session, so a leftover role or claim from a
    // previous statement would silently change what the next one is allowed to do.
    await pg.exec('reset role;')
    let staffClaims: Record<string, unknown> = {}
    if (role === 'authenticated' && userId && verifiedStaffFixtures.has(userId)) {
      let sessionId = staffFixtureSessions.get(userId)
      if (!sessionId) {
        await pg.exec(`create table if not exists auth.sessions (
          id uuid primary key,
          user_id uuid not null references auth.users(id) on delete cascade
        );
        do $fixture$
        begin
          create type auth.factor_status as enum ('unverified', 'verified');
        exception when duplicate_object then null;
        end;
        $fixture$;
        do $fixture$
        begin
          create type auth.factor_type as enum ('totp', 'webauthn');
        exception when duplicate_object then null;
        end;
        $fixture$;
        create table if not exists auth.mfa_factors (
          id uuid primary key,
          user_id uuid not null references auth.users(id) on delete cascade,
          status auth.factor_status not null,
          factor_type auth.factor_type not null,
          created_at timestamptz not null,
          updated_at timestamptz not null,
          secret text
        );
        revoke all on auth.sessions, auth.mfa_factors
          from public, anon, authenticated, service_role;`)
        sessionId = randomUUID()
        await pg.query('insert into auth.sessions(id, user_id) values ($1, $2)', [sessionId, userId])
        await pg.query(
          `insert into auth.mfa_factors(id, user_id, status, factor_type, created_at, updated_at)
           values ($1, $2, 'verified', 'totp', clock_timestamp(), clock_timestamp())`,
          [randomUUID(), userId],
        )
        staffFixtureSessions.set(userId, sessionId)
      }
      // Enroll ONCE on first asUser(), not createUser()/asClaims(). Never
      // recreate a deleted/downgraded factor or session: replay stays refused.
      staffClaims = {
        session_id: sessionId, aal: 'aal2', is_anonymous: false,
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      }
    }
    await pg.query('select set_config($1, $2, false)', [
      'request.jwt.claims',
      userId ? JSON.stringify({ sub: userId, role: 'authenticated', ...staffClaims }) : '',
    ])
    await pg.query('select set_config($1, $2, false)', [
      'request.jwt.claim.sub',
      userId ?? '',
    ])

    if (role !== 'service') {
      await pg.exec(`set role ${role};`)
    }

    try {
      const result = await pg.query<T>(sql, params)
      return result.rows
    } finally {
      await pg.exec('reset role;')
    }
  }

  const asService = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
    runAs<T>('service', null, sql, params)

  const db: TestDb = {
    raw: pg,
    asUser: (userId, sql, params) => runAs('authenticated', userId, sql, params),
    asAnon: (sql, params) => runAs('anon', null, sql, params),
    asService,

    async createUser(opts: CreateUserOpts = {}) {
      userSeq += 1
      const email = opts.email ?? `user${userSeq}@test.example`
      const fullName = opts.fullName ?? `Test User ${userSeq}`

      const rows = await asService<{ id: string }>(
        `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
         values ($1, now(), jsonb_build_object('full_name', $2::text))
         returning id`,
        [email, fullName],
      )
      const id = rows[0]!.id

      // The profile row is created by the app.handle_new_user trigger on
      // auth.users. Everything below is optional test convenience on top of it.
      const updates: string[] = []
      const params: unknown[] = [id]

      if (opts.username) {
        params.push(opts.username)
        updates.push(`username = $${params.length}`)
      }
      if (opts.universityId) {
        params.push(opts.universityId)
        updates.push(`university_id = $${params.length}`)
      }
      // Existing domain scenarios concern published, already-onboarded users.
      // Make their publication explicit now that genuine signup defaults private.
      // Tests of Auth's actual signup hook must use direct auth.users INSERTs.
      params.push(opts.visibility ?? 'public')
      updates.push(`visibility = $${params.length}`)

      if (updates.length > 0) {
        await asService(
          `update public.profiles set ${updates.join(', ')} where id = $1`,
          params,
        )
      }

      if (opts.role) {
        await asService(
          `insert into public.user_roles (user_id, role) values ($1, $2)`,
          [id, opts.role],
        )
        verifiedStaffFixtures.add(id)
      }

      return id
    },

    close: () => pg.close(),
  }

  return db
}

/**
 * Assert that a statement is rejected, and that it is rejected for the reason
 * expected.
 *
 * A permission test that only checks "it threw" is close to worthless: a typo in
 * a column name also throws, and would make the test pass while the policy it
 * claims to verify is wide open. So the matcher is required.
 */
export async function expectRejection(
  fn: () => Promise<unknown>,
  match: RegExp,
): Promise<Error> {
  let caught: Error | null = null
  try {
    await fn()
  } catch (error) {
    caught = error as Error
  }

  if (!caught) {
    throw new Error('Expected the statement to be rejected, but it succeeded.')
  }
  if (!match.test(caught.message)) {
    throw new Error(
      `Statement was rejected, but for the wrong reason.\n` +
        `  expected to match: ${match}\n` +
        `  actual message:    ${caught.message}`,
    )
  }
  return caught
}

/** Common rejection shapes, so tests read as intent rather than as regex. */
export const REJECTS = {
  /** RLS returned no row, or the policy's WITH CHECK failed. */
  rlsViolation: /violates row-level security policy/i,
  /** A column-level GRANT was missing -- the privilege-escalation defence. */
  permissionDenied: /permission denied/i,
  /** A CHECK constraint or explicit RAISE with errcode 23514. */
  checkViolation: /violates check constraint|23514/i,
  /** A UNIQUE constraint or index. */
  uniqueViolation: /duplicate key value|violates unique constraint/i,
  /** An explicit RAISE ... errcode = '42501' from a trigger. */
  notPermitted: /not permitted|42501/i,
  foreignKey: /violates foreign key constraint/i,
} as const
