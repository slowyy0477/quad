'use client'

import { createBrowserClient } from '@supabase/ssr'
import { publicEnv } from '@/lib/env'

/**
 * The browser client.
 *
 * Holds the anon key, which is public and compiled into the bundle. Everything
 * this client is allowed to do is decided by row level security in the database,
 * not by this file -- which is why the migrations carry policies for all 52
 * tables and why the test suite asserts them per role.
 *
 * `createBrowserClient` from @supabase/ssr reads and writes the session as
 * cookies rather than localStorage, so the server sees the same session the
 * browser does. That is the whole point of using it over `createClient`: with
 * localStorage, a Server Component would render as though nobody were signed in.
 *
 * Memoised because @supabase/ssr's realtime and auth listeners are per-instance:
 * creating a second client in another component would open a second websocket and
 * fire duplicate auth events.
 */
let cached: ReturnType<typeof createBrowserClient> | null = null

export function createClient() {
  if (!cached) {
    const env = publicEnv()
    cached = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  }
  return cached
}
