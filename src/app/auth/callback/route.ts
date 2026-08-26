import { NextResponse, type NextRequest } from 'next/server'
import { isSupabaseConfigured } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { safeRedirect } from '@/features/auth/redirect'

/**
 * OAuth and email-link callback.
 *
 * Everything that authenticates out-of-band lands here: Google sign-in, the email
 * confirmation link, the password-reset link. Supabase sends back a one-time
 * `code`, and this handler trades it for a session.
 *
 * This must be a Route Handler rather than a page. The exchange writes session
 * cookies, and a Server Component cannot set cookies -- its response headers are
 * already committed by the time it renders. A handler owns the response.
 *
 * The `next` parameter is passed through `safeRedirect`. It arrives from a
 * redirect chain that includes a third party, so it is untrusted input; see the
 * note in features/auth/redirect.ts for what an open redirect here would buy an
 * attacker.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const next = safeRedirect(url.searchParams.get('next'))

  // The provider rejected it, or the user pressed "cancel" on Google's consent
  // screen. `error_description` comes from a third party, so it is not echoed
  // into the page; the code is enough for the login page to explain itself.
  const providerError = url.searchParams.get('error')
  if (providerError) {
    console.error('[auth:callback]', providerError, url.searchParams.get('error_description'))
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(providerError)}`, url.origin))
  }

  const code = url.searchParams.get('code')
  if (!code) {
    // Somebody opened /auth/callback directly. Nothing to do.
    return NextResponse.redirect(new URL('/login', url.origin))
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(new URL('/setup', url.origin))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Usually an expired or already-redeemed link. Both are one-time codes, so
    // "request a new one" is the only useful advice.
    console.error('[auth:callback:exchange]', error.code ?? error.status, error.message)
    return NextResponse.redirect(new URL('/login?error=link_expired', url.origin))
  }

  return NextResponse.redirect(new URL(next, url.origin))
}
