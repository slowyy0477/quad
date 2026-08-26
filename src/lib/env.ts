/**
 * Environment configuration.
 *
 * Two jobs, and the second is the interesting one.
 *
 * The first is validation: read the variables, check their shape, and give a
 * useful message when one is missing rather than a `TypeError: Cannot read
 * properties of undefined` from three layers down.
 *
 * The second is *not throwing*. A missing Supabase URL is a configuration
 * problem, not a crash, and the difference matters: if this module threw at
 * import time the whole application would fail to render, including the page
 * that explains what to configure. So the parse result is a value. Code that
 * needs a database asks `isSupabaseConfigured()` first and renders an honest
 * "not configured" state when the answer is no.
 *
 * Note that NEXT_PUBLIC_* variables are read through explicit static property
 * accesses. They have to be: the bundler substitutes the literal text
 * `process.env.NEXT_PUBLIC_FOO` at build time, and a dynamic lookup like
 * `process.env[name]` is not substituted and arrives as undefined in the
 * browser.
 */
import { z } from 'zod'

const urlSchema = z
  .string()
  .min(1)
  .url('must be a full URL including https://')
  .refine((value) => !value.endsWith('/'), 'must not end with a trailing slash')

/**
 * A Supabase key is a long opaque string. Checking the length is not a
 * cryptographic verification; it catches the common paste error of copying a
 * project ref or a truncated value into the wrong box.
 */
const keySchema = z.string().min(20, 'looks too short to be a Supabase key')

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlSchema,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: keySchema,
  NEXT_PUBLIC_SITE_URL: urlSchema.optional().or(z.literal('')),
})

export type PublicEnv = z.infer<typeof publicSchema>

const rawPublic = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? '',
}

const parsedPublic = publicSchema.safeParse(rawPublic)

/** True when the browser and server have everything they need to reach Supabase. */
export function isSupabaseConfigured(): boolean {
  return parsedPublic.success
}

/**
 * The validated public environment.
 *
 * Throws if called when `isSupabaseConfigured()` is false. That is deliberate:
 * by the time something is building a database client, a missing URL is no longer
 * a state to render, it is a bug in the calling code.
 */
export function publicEnv(): PublicEnv {
  if (!parsedPublic.success) {
    throw new Error(
      `Supabase is not configured. ${describeEnvProblems().join(' ')} ` +
        'Copy .env.example to .env.local and fill it in.',
    )
  }
  return parsedPublic.data
}

/**
 * Human-readable descriptions of what is wrong, for the setup page and the
 * server log. Deliberately says which variable and what about it -- and
 * deliberately never includes the value, so a screenshot of the setup page
 * cannot leak a key.
 */
export function describeEnvProblems(): string[] {
  if (parsedPublic.success) return []

  // Deduplicated. One empty variable produces several issues -- `min(1)` and
  // `url()` both fail on '' -- and all of them describe the same missing value, so
  // an undeduped list says "NEXT_PUBLIC_SUPABASE_URL is not set" twice and reads
  // like two separate faults.
  const seen = new Set<string>()
  for (const issue of parsedPublic.error.issues) {
    const name = issue.path.join('.')
    seen.add(
      rawPublic[name as keyof typeof rawPublic] === ''
        ? `${name} is not set.`
        : `${name} ${issue.message}.`,
    )
  }
  return [...seen]
}

/**
 * The canonical origin of this deployment.
 *
 * Used to build the OAuth redirect URL. Getting this wrong in production sends a
 * user -- and their authorization code -- to the wrong origin, so it is required
 * there and falls back only in development.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, '')

  if (process.env.NODE_ENV === 'production') {
    // Vercel sets this automatically for preview and production deployments.
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
    if (vercel) return `https://${vercel}`
  }

  return 'http://localhost:3000'
}

/**
 * The service role key, for the few server-side callers that legitimately need
 * to bypass row level security.
 *
 * Not part of the schema above, and not read at module scope, because this file
 * is imported by Client Components through the shared helpers: keeping the secret
 * behind a function call means the string never appears in a module the bundler
 * might follow into a client bundle. src/lib/supabase/admin.ts is the only
 * caller, and it imports 'server-only'.
 */
export function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. It is required only for ' +
        'administrative scripts; see docs/ENVIRONMENT.md.',
    )
  }
  return key
}

export function hasServiceRoleKey(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
}
