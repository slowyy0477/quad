import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Proxy — session refresh and route gating.
 *
 * In Next 16 this file is `proxy.ts`; `middleware.ts` is the deprecated name for
 * the same convention.
 *
 * It does two things, and the first is not optional. Supabase access tokens are
 * short-lived, and the refresh has to happen somewhere that can write cookies.
 * Server Components cannot -- their response headers are already committed -- so
 * without this file every session would die at the first token expiry and users
 * would be silently signed out mid-session. Calling `getUser()` here performs the
 * refresh, and the rewritten cookies ride out on the response below.
 *
 * The second is a redirect for signed-out visitors hitting private routes. That
 * is a *convenience*, not a security boundary, and it is important to be clear
 * about which. Anyone can craft a request that never reaches this file: a direct
 * PostgREST call with the anon key skips the application entirely. What actually
 * protects data is row level security in Postgres. This just spares a signed-out
 * visitor an empty page.
 *
 * Note the cookie dance. `request.cookies.set` is what the *rest of this request*
 * reads -- the Server Components rendering downstream -- and `response.cookies.set`
 * is what the *browser* stores. Setting only one of them produces a bug that looks
 * like a caching problem: the page renders signed-out, then a refresh fixes it.
 */

/** Routes that require a session. Everything else is public. */
const PRIVATE_PREFIXES = [
  '/feed',
  '/messages',
  '/notifications',
  '/settings',
  '/onboarding',
  '/admin',
  '/goals',
  '/semester',
  '/saved',
]

/** Routes that a signed-in user has no business seeing. */
const AUTH_ONLY_PREFIXES = ['/login', '/signup', '/reset-password']

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export async function proxy(request: NextRequest) {
  const url = request.nextUrl.clone()
  const { pathname } = url

  // Local mode: no Supabase session to refresh and no server-side gate worth
  // putting in front of a file-backed store. Each page decides for itself and
  // renders a sign-in prompt, which is the better experience anyway.
  if (process.env.NEXT_PUBLIC_DATA_MODE === 'local') {
    return NextResponse.next()
  }

  // With no Supabase configuration there is no session to refresh and no
  // authenticated area to protect. Let everything through so the setup page can
  // explain itself, rather than redirect-looping on a missing environment.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.next()
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Not getSession(): that reads the cookie without verifying it. getUser()
  // validates the token with the auth server, and performs the refresh this file
  // exists for.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user && matches(pathname, PRIVATE_PREFIXES)) {
    const redirect = url.clone()
    redirect.pathname = '/login'
    redirect.search = ''
    // Preserve where they were going, so signing in doesn't dump them on a
    // generic landing page having forgotten what they clicked.
    redirect.searchParams.set('next', `${pathname}${url.search}`)
    return NextResponse.redirect(redirect)
  }

  if (user && matches(pathname, AUTH_ONLY_PREFIXES)) {
    const redirect = url.clone()
    redirect.pathname = '/feed'
    redirect.search = ''
    return NextResponse.redirect(redirect)
  }

  return response
}

export const config = {
  /**
   * Everything except static assets and images. Without a matcher the proxy runs
   * on `_next/static` too, which would put an auth check in front of the
   * stylesheet -- and a redirect there does not fail loudly, it just renders the
   * site unstyled.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)',
  ],
}
