import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { publicEnv, serviceRoleKey } from '@/lib/env'

/**
 * The service role client. Bypasses row level security entirely.
 *
 * `import 'server-only'` is the guard that matters: if any module reachable from a
 * Client Component imports this file, the build fails with an explicit error
 * rather than shipping a key that can read every private message on the platform
 * to a browser. It is a build-time assertion, not a runtime hope.
 *
 * There is deliberately no session persistence and no auto-refresh: this client
 * has no user and no session to refresh, and leaving those on would have it write
 * to a cookie store that does not exist.
 *
 * When to use it: administrative scripts, and server-side work that has a written
 * reason to bypass RLS. When not to use it: anything a signed-in user triggers.
 * Reaching for this to "just make the query work" replaces the database's
 * authorization with your own memory of what the rules were.
 */
export function createAdminClient() {
  const env = publicEnv()

  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
