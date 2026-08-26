import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { publicEnv } from '@/lib/env'

/**
 * The server client, for Server Components, Server Actions and Route Handlers.
 *
 * Two things worth knowing.
 *
 * First, `cookies()` is async in Next 16, so this function is async and cannot be
 * called at module scope. Every caller awaits it per request; there is nothing to
 * memoise, because a client built from one request's cookies must never be reused
 * for another user's request. That is not a performance note, it is the entire
 * security model of the thing.
 *
 * Second, `setAll` is wrapped in a try/catch. A Server Component cannot write
 * cookies -- the response headers are already committed by the time it renders --
 * and @supabase/ssr will try to write refreshed tokens when a session is close to
 * expiry. Swallowing that failure is correct *only because* proxy.ts refreshes the
 * session on every request before any component renders, so the write that fails
 * here has already succeeded there. Without the proxy this catch would silently
 * sign users out an hour after they logged in.
 */
export async function createClient() {
  const env = publicEnv()
  const cookieStore = await cookies()

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component. See the note above: proxy.ts has
          // already refreshed and written the session for this request.
        }
      },
    },
  })
}

/**
 * The signed-in user, or null.
 *
 * Always `getUser()`, never `getSession()`. `getSession()` returns whatever is in
 * the cookie without verifying it, which means a forged cookie would be believed.
 * `getUser()` validates the JWT against the auth server. On a page that decides
 * what someone may see, the difference between "the cookie says Ana" and "Ana"
 * is the whole question.
 */
export async function getUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}
