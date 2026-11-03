import 'server-only'

import type { LifecycleErrorCode, LifecycleResult } from './types'
import { LIFECYCLE_ERROR_MESSAGES } from './types'

export const ACCOUNT_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, Authorization',
  'Cross-Origin-Resource-Policy': 'same-origin',
}
const MAX_REQUEST_BYTES = 12 * 1024

export function accountError(code: LifecycleErrorCode, status?: number, retryAfterSeconds?: number) {
  const codes: Partial<Record<LifecycleErrorCode, number>> = {
    signed_out: 401, identity_mismatch: 409, invalid_password: 403, throttled: 429,
    invalid_request: 400, confirmation_required: 400, ownership_transfer_required: 409,
    owner_role_inconsistent: 409, last_administrator: 409, shared_media_ownership: 409,
    provider_assurance_required: 403, account_unavailable: 403, export_too_large: 413, not_found: 404,
  }
  return Response.json({ ok: false, code, message: LIFECYCLE_ERROR_MESSAGES[code] }, {
    status: status ?? codes[code] ?? 503,
    headers: { ...ACCOUNT_RESPONSE_HEADERS, ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}) },
  })
}

export function accountResult<T>(result: LifecycleResult<T>, successStatus = 200) {
  return result.ok
    ? Response.json({ ok: true, value: result.value }, { status: successStatus, headers: ACCOUNT_RESPONSE_HEADERS })
    : accountError(result.code, undefined, result.retryAfterSeconds)
}

/** Independent sensitive-endpoint CSRF check: require an exact browser Origin. */
export function accountRequestOriginAllowed(request: Request): boolean {
  try {
    const actual = new URL(request.url)
    const configured = process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SITE_URL
    const expected = new URL(configured || `${actual.protocol}//${request.headers.get('host') || actual.host}`)
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password ||
        expected.pathname !== '/' || expected.search || expected.hash) return false
    if (request.headers.get('sec-fetch-site') === 'cross-site') return false
    return request.headers.get('origin') === expected.origin
  } catch { return false }
}

export async function readAccountRequest(request: Request): Promise<{ body: unknown } | { response: Response }> {
  if (!accountRequestOriginAllowed(request)) return { response: accountError('invalid_request', 403) }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { response: accountError('invalid_request', 415) }
  }
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    return { response: accountError('invalid_request', 413) }
  }
  const reader = request.body?.getReader()
  if (!reader) return { response: accountError('invalid_request', 400) }
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel()
        return { response: accountError('invalid_request', 413) }
      }
      chunks.push(chunk.value)
    }
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch { return { response: accountError('invalid_request', 400) } }
  finally { reader.releaseLock() }
}
