import { NextResponse, type NextRequest } from 'next/server'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE,
  RECOVERY_COOKIE_PATH,
  validRecoveryTokenHash,
} from '@/features/auth/recovery'

export const runtime = 'nodejs'

/**
 * Stage a provider-owned one-time token, stripping it from the visible URL.
 * Do not redeem on GET: email scanners/prefetch must not consume reset authority.
 * The form POST always verifies type: recovery, expiry and one-time use at Auth.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token_hash')
  const available = !isLocalMode() && isSupabaseConfigured()
  const valid = available && validRecoveryTokenHash(token) &&
    !url.searchParams.has('error') &&
    (!url.searchParams.has('type') || url.searchParams.get('type') === 'recovery')
  const response = NextResponse.redirect(new URL(
    valid ? '/settings/password?recovery=1' : '/reset-password?error=recovery_link',
    url.origin,
  ))
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.cookies.set(RECOVERY_COOKIE, valid ? token! : '', {
    path: RECOVERY_COOKIE_PATH,
    maxAge: valid ? RECOVERY_COOKIE_MAX_AGE : 0,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  return response
}
