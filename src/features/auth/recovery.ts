import 'server-only'

import { cookies } from 'next/headers'

export const RECOVERY_COOKIE = 'bulla_password_recovery'
export const RECOVERY_COOKIE_PATH = '/settings/password'
export const RECOVERY_COOKIE_MAX_AGE = 10 * 60

export function validRecoveryTokenHash(value: unknown): value is string {
  // Auth adds this prefix to TokenHash for PKCE recovery emails. Preserve it
  // verbatim: the provider's one-time-token lookup owns validation.
  return typeof value === 'string' && /^(?:pkce_)?[a-f0-9]{64}$/i.test(value)
}

/** An unredeemed provider token, NOT a verified user/session or a reusable grant. */
export async function pendingRecoveryToken(): Promise<string | null> {
  const value = (await cookies()).get(RECOVERY_COOKIE)?.value
  return validRecoveryTokenHash(value) ? value : null
}

export async function clearRecoveryToken(): Promise<void> {
  const store = await cookies()
  store.set(RECOVERY_COOKIE, '', {
    path: RECOVERY_COOKIE_PATH,
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

/**
 * Call ONLY on claims returned by auth.getClaims(access_token), immediately
 * after this POST successfully redeems verifyOtp({ type: 'recovery' }).
 * OTP AMR alone does not distinguish recovery from signup/magic links.
 */
export function freshRecoveryClaims(
  value: unknown,
  expectedUserId: string,
  timestamp = Date.now(),
): boolean {
  if (!value || typeof value !== 'object') return false
  const claims = value as Record<string, unknown>
  const seconds = Math.floor(timestamp / 1_000)
  if (claims.sub !== expectedUserId || claims.role !== 'authenticated' ||
      typeof claims.session_id !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(claims.session_id)) return false
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) ||
      claims.iat < seconds - 60 || claims.iat > seconds + 30 ||
      claims.exp <= seconds || claims.exp <= claims.iat) return false
  if (!Array.isArray(claims.amr)) return false
  return claims.amr.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false
    const method = entry as Record<string, unknown>
    return (method.method === 'otp' || method.method === 'recovery') &&
      typeof method.timestamp === 'number' && Number.isFinite(method.timestamp) &&
      method.timestamp >= seconds - 60 && method.timestamp <= seconds + 30
  })
}
