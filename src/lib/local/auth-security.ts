import 'server-only'

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { DEFAULT_DESTINATION } from '@/features/auth/redirect'
import type { AuthFormState } from '@/features/auth/form-state'

export type AuthAttemptKind = 'login' | 'signup'
const WINDOW_MS = { login: 15 * 60_000, signup: 60 * 60_000 }
const ACCOUNT_LIMIT = { login: 5, signup: 3 }
const SOURCE_LIMIT = { login: 60, signup: 20 }
const MAX_BUCKETS = 10_000
const buckets = new Map<string, { count: number; resetAt: number }>()
let lastSweep = 0

/**
 * Single-process abuse control. Restarting/redeploying resets the budgets.
 * The safe default shares a source budget: arbitrary forwarded headers cannot
 * create fresh buckets. A trusted gateway must supply one overwritten address.
 */
export function authAttemptSource(requestHeaders: Pick<Headers, 'get'>): string {
  if (process.env.LOCAL_AUTH_TRUST_PROXY !== 'true') return 'shared-untrusted'
  const address = requestHeaders.get('x-forwarded-for')?.trim() ?? ''
  return isIP(address) ? address : 'shared-untrusted'
}

export function consumeAuthAttempt(kind: AuthAttemptKind, email: string, source = 'shared-untrusted', timestamp = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  if (timestamp - lastSweep >= 30_000) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= timestamp) buckets.delete(key)
    lastSweep = timestamp
  }
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const keys = [
    { key: `${kind}:account:${digest(email.trim().toLowerCase().slice(0, 254))}`, limit: ACCOUNT_LIMIT[kind] },
    { key: `${kind}:source:${digest(source)}`, limit: SOURCE_LIMIT[kind] },
  ]
  for (const { key } of keys) if ((buckets.get(key)?.resetAt ?? Infinity) <= timestamp) buckets.delete(key)
  const blocked = keys.map(({ key }) => buckets.get(key)).filter((bucket, index) => bucket && bucket.count >= keys[index].limit)
  if (blocked.length) return { allowed: false, retryAfterSeconds: Math.max(...blocked.map((bucket) => Math.ceil((bucket!.resetAt - timestamp) / 1000))) }
  if (buckets.size + keys.filter(({ key }) => !buckets.has(key)).length > MAX_BUCKETS) return { allowed: false, retryAfterSeconds: 60 }
  // No await between the check and increments: one event-loop transaction.
  for (const { key } of keys) {
    const bucket = buckets.get(key) ?? { count: 0, resetAt: timestamp + WINDOW_MS[kind] }
    bucket.count += 1
    buckets.set(key, bucket)
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Validate every decoding layer without returning a decoded/normalized attacker path. */
export function safeLocalRedirect(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048) return DEFAULT_DESTINATION
  let value = raw
  const unsafe = new RegExp('[\\u0000-\\u001f\\u007f\\\\]')
  for (let depth = 0; depth < 8; depth += 1) {
    if (!value.startsWith('/') || value.startsWith('//') || unsafe.test(value)) return DEFAULT_DESTINATION
    try {
      if (new URL(value, 'https://local.invalid').pathname.startsWith('//')) return DEFAULT_DESTINATION
      const decoded = decodeURIComponent(value)
      if (decoded === value) return raw
      value = decoded
    } catch {
      return DEFAULT_DESTINATION
    }
  }
  return DEFAULT_DESTINATION
}

export function throttledAuthState(retryAfterSeconds: number): AuthFormState {
  return { status: 'error', message: `Too many attempts. Try again in ${retryAfterSeconds} seconds.` }
}
