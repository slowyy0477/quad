import { createServerClient } from '@supabase/ssr'
import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { contentSecurityPolicy } from './lib/security-headers'
import { assertNotDeployedInLocalMode } from './lib/mode'

const PRIVATE_PREFIXES = ['/feed', '/messages', '/notifications', '/settings', '/onboarding', '/admin', '/goals', '/semester', '/saved', '/log', '/me']
const AUTH_ONLY_PREFIXES = ['/login', '/signup']
const DIAGNOSTIC_PREFIXES = [
  '/status', '/setup', '/status.rsc', '/setup.rsc',
  '/status.segments', '/setup.segments',
]
// A standalone, non-sensitive fallback avoids starting a streamed page/Flight
// response. Do not interpolate configuration, request data or inventory here.
const DIAGNOSTIC_NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Page not found | Bulla</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:32rem;margin:5rem auto;padding:1.5rem}
h1{font-size:1.5rem;line-height:1.3}p{line-height:1.6}
nav{display:flex;flex-wrap:wrap;gap:1rem;margin-top:2rem}
a{color:inherit;min-height:2.75rem;display:inline-flex;align-items:center}
</style></head><body><main><p>404</p>
<h1>There is nothing at this address</h1>
<p>The page may have moved or the address may be incorrect. Return to Bulla or visit Help.</p>
<nav aria-label="Return to Bulla"><a href="/">Go to the homepage</a><a href="/help">Help</a></nav>
</main></body></html>`
function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function passwordEntry(url: NextRequest['nextUrl'], flag: 'recovery' | 'changed') {
  const values = url.searchParams.getAll(flag)
  const otherFlag = flag === 'recovery' ? 'changed' : 'recovery'
  return url.pathname === '/settings/password' && values.length === 1 &&
    values[0] === '1' && !url.searchParams.has(otherFlag)
}

function copyCookies(source: NextResponse, target: NextResponse) {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie)
  return target
}

function browserOrigin(request: NextRequest): string | null {
  // NextURL normalizes loopback IPs to localhost. Origin is the browser's real
  // authority, so a legitimate 127.0.0.1 POST must use Host, not nextUrl.origin.
  // Public deployments use their configured external origin behind replicas.
  // Never accept an arbitrary x-forwarded-host supplied by the client.
  try {
    const configured = process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SITE_URL
    const expected = configured
      ? new URL(configured)
      : new URL(`${request.nextUrl.protocol}//${request.headers.get('host') || request.nextUrl.host}`)
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username ||
        expected.password || expected.pathname !== '/' || expected.search || expected.hash) return null
    return expected.origin
  } catch {
    return null
  }
}

/** CSP is request-bound. Every page/action still independently checks access. */
export async function proxy(request: NextRequest) {
  const url = request.nextUrl.clone()
  const nonce = randomBytes(18).toString('base64')
  const csp = contentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  const finish = (response: NextResponse) => {
    response.headers.set('Content-Security-Policy', csp)
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    return response
  }
  const next = () => NextResponse.next({ request: { headers: requestHeaders } })
  // Next strips internal Flight headers from Proxy, and streamed notFound()
  // can retain HTTP 200. Deny every diagnostic transport before rendering or
  // provider reads instead of treating HTML and prefetch differently.
  if (process.env.NODE_ENV !== 'development' && matches(url.pathname, DIAGNOSTIC_PREFIXES)) {
    return finish(new NextResponse(request.method === 'HEAD' ? null : DIAGNOSTIC_NOT_FOUND, {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    }))
  }
  const origin = request.headers.get('origin')
  const expectedOrigin = browserOrigin(request)
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL
  // Cloud serving must not fall back to a request host or a localhost URL in
  // production. Keep private local reviews and unconfigured setup unaffected.
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_DATA_MODE !== 'local' &&
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      (!configuredOrigin || !expectedOrigin?.startsWith('https://') || configuredOrigin !== expectedOrigin)) {
    return finish(new NextResponse('Bulla requires a canonical HTTPS site origin for a public deployment.', { status: 503 }))
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && origin !== expectedOrigin) {
    return finish(new NextResponse('Cross-origin writes are not allowed.', { status: 403 }))
  }

  if (process.env.NEXT_PUBLIC_DATA_MODE === 'local') {
    try {
      assertNotDeployedInLocalMode()
    } catch {
      return finish(new NextResponse('Bulla is not configured for a public deployment.', { status: 503 }))
    }
    return finish(next())
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return finish(next())

  const recoveryEntry = passwordEntry(url, 'recovery')
  const readRequest = request.method === 'GET' || request.method === 'HEAD'
  // An unsigned recovery POST is only an entry to provider verification, never
  // settings authorization. Require an explicit, matching browser Origin.
  if (recoveryEntry && request.method === 'POST' && (!origin || origin !== expectedOrigin)) {
    return finish(new NextResponse('Cross-origin writes are not allowed.', { status: 403 }))
  }

  let response = next()
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() { return request.cookies.getAll() },
      setAll(items) {
        for (const { name, value } of items) request.cookies.set(name, value)
        requestHeaders.set('cookie', request.headers.get('cookie') || '')
        response = copyCookies(response, next())
        for (const { name, value, options } of items) response.cookies.set(name, value, options)
      },
    },
  })
  const { data: { user } } = await supabase.auth.getUser()
  // This one opaque, status-only receipt must remain accessible after deletion
  // revokes the session. The parent settings/account routes stay private.
  const deletionReceipt = url.pathname === '/settings/account/deletion'
  // Neither scalar flag nor any cookie authenticates a user. The recovery
  // page/action retains its capability, token redemption and session guards;
  // the changed receipt is informational and must never admit a signed-out POST.
  const passwordFlowEntry = (recoveryEntry && (readRequest || request.method === 'POST')) ||
    (passwordEntry(url, 'changed') && readRequest)
  if (!user && !deletionReceipt && !passwordFlowEntry && matches(url.pathname, PRIVATE_PREFIXES)) {
    const target = url.clone()
    target.pathname = '/login'
    target.search = ''
    target.searchParams.set('next', `${url.pathname}${url.search}`)
    return finish(copyCookies(response, NextResponse.redirect(target)))
  }
  if (user && matches(url.pathname, AUTH_ONLY_PREFIXES)) {
    const target = url.clone()
    target.pathname = '/feed'
    target.search = ''
    return finish(copyCookies(response, NextResponse.redirect(target)))
  }
  return finish(response)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|offline.html|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)'],
}
