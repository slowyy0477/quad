/**
 * Rate limiting, from the server's side.
 *
 * The limiter itself is in Postgres — migration 0021 — because a counter that
 * lives in the process cannot limit anything on a platform where every request
 * may be a different instance. This module is the thin client for it: one call,
 * one boolean, and the bucket definitions.
 *
 * Failing closed is deliberate. If the check cannot be performed the action does
 * not proceed, because the only reason to be in this code at all is to write
 * something, and that write needs the same database connection. Failing open
 * would mean an outage silently removes the limit.
 */

import 'server-only'

import { isSupabaseConfigured } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

/**
 * Every limit the application enforces, in one table.
 *
 * The bucket name is the database key, so it must stay stable: renaming one
 * resets everybody's budget, which is a harmless but real consequence of editing
 * this file.
 *
 * The numbers all sit together rather than at each call site (ARCHITECTURE §4
 * sketches `.use(rateLimit('post:create', 10, 3600))` with the numbers inline).
 * One table is worth the small deviation: a limit is a product decision, and
 * product decisions that are copy-pasted across five feature modules stop being
 * decisions and become accidents.
 */
export const RATE_LIMITS = {
  /** Filing a report. Generous, because reporting is how the platform is kept
   *  usable, and a reporter who has hit a limit stops reporting. */
  'report:file': { limit: 10, windowSeconds: 3600 },
  /** Reporting a bug. */
  'bug:file': { limit: 5, windowSeconds: 3600 },
  /** The maintainer triaging bug reports. */
  'bug:triage': { limit: 60, windowSeconds: 3600 },
  /** A moderator deciding reports. Set well above any human rate, so it only
   *  ever stops a script; a queue worked at 60 decisions an hour is not a queue
   *  anyone is reading. */
  'moderation:decide': { limit: 120, windowSeconds: 3600 },
  /** Reviewing university requests, same reasoning. */
  'moderation:university': { limit: 60, windowSeconds: 3600 },
} as const

export type RateLimitBucket = keyof typeof RATE_LIMITS

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; message: string }

/**
 * Ask Postgres whether this caller is within budget for a bucket.
 *
 * Returns a verdict rather than throwing: "you are doing that too quickly" and
 * "the database is unreachable" need different copy, and a thrown error would
 * merge them into one path (the same mistake 0005's `can_message` comment warns
 * about for a different case).
 */
export async function checkRateLimit(bucket: RateLimitBucket): Promise<RateLimitVerdict> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket]

  // With no database configured there is nothing to write and no session to key
  // a limit on, so a refusal here would be a confusing lie about the real state
  // of the deployment. The actions that call this say the deployment has no
  // database before reaching this point.
  if (!isSupabaseConfigured()) return { allowed: true }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  })

  if (error) {
    // Logged with the code, reported as a refusal. Fail closed: an unreadable
    // counter is not permission.
    console.error('[rate-limit]', bucket, error.code, error.message)
    return {
      allowed: false,
      message: 'That could not be checked just now, so it was not saved. Please try again.',
    }
  }

  if (data !== true) {
    return {
      allowed: false,
      message:
        'You have done that several times in the last hour. Try again shortly, or get in touch if it is urgent.',
    }
  }

  return { allowed: true }
}
