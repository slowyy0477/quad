/**
 * Rate limiting, from the server's side.
 *
 * The limiter itself is in Postgres — migrations 0021 and 0025 — because a counter that
 * lives in the process cannot limit anything on a platform where every request
 * may be a different instance. This is a non-consuming preflight, not a permit:
 * mandatory row triggers charge the actual write in its database transaction.
 * Direct REST, batches and authenticated SECURITY DEFINER RPCs use those triggers.
 *
 * Failing closed is deliberate. If the check cannot be performed the action does
 * not proceed, because the only reason to be in this code at all is to write
 * something, and that write needs the same database connection. Failing open
 * would mean an outage silently removes the limit.
 */

import 'server-only'

import { isSupabaseConfigured } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { isRateLimitBucket, RATE_LIMITS, type RateLimitBucket } from './budgets'

export { RATE_LIMITS, type RateLimitBucket } from './budgets'

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; message: string }

/**
 * Ask Postgres whether this caller currently has room for a write.
 * This never reserves or consumes a hit. Another writer can spend the last hit
 * after this returns; callers must still handle a refused INSERT/UPDATE.
 *
 * Returns a verdict rather than throwing: "you are doing that too quickly" and
 * "the database is unreachable" need different copy, and a thrown error would
 * merge them into one path (the same mistake 0005's `can_message` comment warns
 * about for a different case).
 */
export async function checkRateLimit(bucket: RateLimitBucket): Promise<RateLimitVerdict> {
  if (!isRateLimitBucket(bucket)) {
    return { allowed: false, message: 'That write budget is not available.' }
  }
  const { limit, windowSeconds } = RATE_LIMITS[bucket]

  // With no database configured there is nothing to write and no session to key
  // a limit on, so a refusal here would be a confusing lie about the real state
  // of the deployment. The actions that call this say the deployment has no
  // database before reaching this point.
  if (!isSupabaseConfigured()) return { allowed: true }

  let response
  try {
    const supabase = await createClient()
    response = await supabase.rpc('check_rate_limit', {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
  } catch {
    // Do not log raw exceptions that might contain request/credential material.
    console.error('[rate-limit]', bucket, 'preflight_unavailable')
    return {
      allowed: false,
      message: 'That could not be checked just now, so it was not saved. Please try again.',
    }
  }
  const { data, error } = response

  if (error) {
    // Logged with the code, reported as a refusal. Fail closed: an unreadable
    // counter is not permission.
    console.error('[rate-limit]', bucket, error.code)
    return {
      allowed: false,
      message: 'That could not be checked just now, so it was not saved. Please try again.',
    }
  }

  if (data !== true) {
    return {
      allowed: false,
      message:
        `You have done that several times in the last ${windowSeconds === 60 ? 'minute' : 'hour'}. Try again shortly, or get in touch if it is urgent.`,
    }
  }

  return { allowed: true }
}
