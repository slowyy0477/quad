/**
 * Mirror of the server-owned catalogue in 0025_mandatory_abuse_limits.sql.
 * These are product budgets, not caller options. SQL is authoritative for REST.
 * Fixed UTC windows permit a burst of up to 2N across a window boundary.
 */
export const RATE_LIMITS = Object.freeze({
  'post:write': Object.freeze({ limit: 60, windowSeconds: 3600 }),
  'comment:write': Object.freeze({ limit: 120, windowSeconds: 3600 }),
  'reaction:write': Object.freeze({ limit: 300, windowSeconds: 3600 }),
  'save:write': Object.freeze({ limit: 200, windowSeconds: 3600 }),
  'message:write': Object.freeze({ limit: 60, windowSeconds: 60 }),
  'project:write': Object.freeze({ limit: 30, windowSeconds: 3600 }),
  'idea:write': Object.freeze({ limit: 30, windowSeconds: 3600 }),
  'opportunity:write': Object.freeze({ limit: 20, windowSeconds: 3600 }),
  'event:write': Object.freeze({ limit: 20, windowSeconds: 3600 }),
  'event:rsvp': Object.freeze({ limit: 120, windowSeconds: 3600 }),
  'university:request': Object.freeze({ limit: 5, windowSeconds: 3600 }),
  // Existing wrapper names and values stay compatible.
  'report:file': Object.freeze({ limit: 10, windowSeconds: 3600 }),
  'bug:file': Object.freeze({ limit: 5, windowSeconds: 3600 }),
  'bug:triage': Object.freeze({ limit: 60, windowSeconds: 3600 }),
  'moderation:decide': Object.freeze({ limit: 120, windowSeconds: 3600 }),
  'moderation:university': Object.freeze({ limit: 60, windowSeconds: 3600 }),
})

export type RateLimitBucket = keyof typeof RATE_LIMITS

export function isRateLimitBucket(value: unknown): value is RateLimitBucket {
  return typeof value === 'string' && Object.hasOwn(RATE_LIMITS, value)
}
