import 'server-only'

import { isDeepStrictEqual } from 'node:util'
import { isRateLimitBucket, RATE_LIMITS, type RateLimitBucket } from '@/lib/rate-limit/budgets'

export type LocalMutationLimitWindow = {
  id: string
  bucket: RateLimitBucket
  /** Verified session USER id, not a form field or the edited row's owner. */
  subject: string
  window_start_ms: number
  hits: number
}

export type MutationLimitContext = {
  actorUserId: string | null
  /** Capture under the store's filesystem lock, never from client input. */
  nowMs: number
}

export class MutationLimitError extends Error {
  readonly code = 'rate_limit_exceeded'

  constructor(
    readonly bucket: RateLimitBucket,
    readonly retryAfterSeconds: number,
  ) {
    super(`Write refused: rate_limit_exceeded (${bucket}). Try again shortly.`)
    this.name = 'MutationLimitError'
  }
}

type MutationRow = Record<string, unknown> & { id: string }
type Snapshot = Record<string, unknown>
const RETENTION_MS = 24 * 60 * 60_000
const MAX_WINDOWS = 10_000
const STAMPS = ['updated_at', 'is_edited', 'edited_at']
const REPORT_TARGETS = {
  post_id: 'posts',
  comment_id: 'comments',
  project_id: 'projects',
  idea_id: 'ideas',
  message_id: 'messages',
  opportunity_id: 'opportunities',
  event_id: 'events',
} as const
const DERIVED_NULL_REFERENCES: Readonly<Record<string, readonly (readonly [column: string, targetTable: string])[]>> = {
  posts: [['project_id', 'projects'], ['goal_id', 'goals']],
  comments: [['parent_id', 'comments']],
  ideas: [['converted_project_id', 'projects']],
  messages: [['reply_to_id', 'messages']],
  university_requests: [['reviewed_by', 'profiles']],
}

const TABLES = {
  posts: ['post:write', ['like_count', 'comment_count', 'save_count', 'university_id']],
  comments: ['comment:write', ['like_count', 'reply_count']],
  idea_comments: ['comment:write', []],
  post_likes: ['reaction:write', []],
  idea_votes: ['reaction:write', []],
  project_stars: ['reaction:write', []],
  post_saves: ['save:write', []],
  opportunity_saves: ['save:write', []],
  messages: ['message:write', []],
  projects: ['project:write', ['member_count', 'application_count', 'star_count', 'post_count', 'university_id']],
  // A response is charged once; its derived membership/count/notification is not
  // a second project edit. Conversion fan-out still charges every real invite.
  project_invites: ['project:write', []],
  ideas: ['idea:write', ['upvote_count', 'interest_count', 'comment_count', 'university_id']],
  opportunities: ['opportunity:write', ['save_count', 'university_id']],
  events: ['event:write', ['attendee_count', 'going_count', 'interested_count', 'university_id']],
  event_attendees: ['event:rsvp', []],
  reports: ['report:file', []],
  // Local requests are a separate table; approval also inserts a catalogue row.
  // Charging that derived universities insert would double-charge the review.
  university_requests: ['university:request', []],
  bug_reports: ['bug:file', []],
} as const satisfies Record<string, readonly [RateLimitBucket, readonly string[]]>

function invalidState(): never {
  throw new Error('Invalid local mutation-limit state. Nothing was saved; restore or inspect the isolated ledger.')
}

function rowsById(value: unknown): Map<string, MutationRow> {
  if (value === undefined) return new Map()
  if (!Array.isArray(value)) return invalidState()
  const result = new Map<string, MutationRow>()
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.id !== 'string' || !row.id || result.has(row.id)) {
      return invalidState()
    }
    result.set(row.id, row)
  }
  return result
}

function projection(row: MutationRow, ignored: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) =>
    !STAMPS.includes(key) && !ignored.includes(key),
  ))
}

function derivedReferenceIgnores(
  table: string,
  previous: MutationRow,
  proposedRow: MutationRow,
  proposed: Snapshot,
  targetCache: Map<string, Map<string, MutationRow>>,
): string[] {
  const ignored: string[] = []
  for (const [column, targetTable] of DERIVED_NULL_REFERENCES[table] ?? []) {
    const oldTarget = previous[column]
    if (typeof oldTarget !== 'string' || !oldTarget || proposedRow[column] !== null) continue
    // Missing target tables cannot prove deletion. The real commit supplies
    // complete Tables snapshots; malformed or partial state must fail closed.
    if (proposed[targetTable] === undefined) continue
    let targets = targetCache.get(targetTable)
    if (!targets) {
      targets = rowsById(proposed[targetTable])
      targetCache.set(targetTable, targets)
    }
    // Emulate only derived SET NULL cleanup. A live (even soft-deleted) target,
    // reattachment, or a different column is still an ordinary charged edit.
    if (!targets.has(oldTarget)) ignored.push(column)
  }
  return ignored
}

function subjectIsValid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function ledgerFrom(snapshot: Snapshot, nowMs: number): Map<string, LocalMutationLimitWindow> {
  const ledger = snapshot.mutation_limit_windows ?? []
  if (!Array.isArray(ledger) || ledger.length > MAX_WINDOWS) return invalidState()
  const result = new Map<string, LocalMutationLimitWindow>()
  const seen = new Set<string>()
  for (const entry of ledger) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalidState()
    const { id, bucket, subject, window_start_ms: start, hits } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !isRateLimitBucket(bucket) ||
        !subjectIsValid(subject) || typeof start !== 'number' || !Number.isSafeInteger(start) ||
        start < 0 || start > nowMs ||
        start % (RATE_LIMITS[bucket].windowSeconds * 1000) !== 0 ||
        typeof hits !== 'number' || !Number.isSafeInteger(hits) || hits < 1 ||
        id !== `${bucket}:${subject}:${start}` || seen.has(id)) {
      return invalidState()
    }
    seen.add(id)
    // Expired entries may be pruned; never evict an active budget to admit a write.
    if (start >= nowMs - RETENTION_MS) result.set(id, { id, bucket, subject, window_start_ms: start, hits })
  }
  return result
}

/**
 * Deterministic, I/O-free commit hook. Returns the ledger to commit alongside
 * the proposed tables; it does not modify either snapshot or the real store.
 *
 * Integration MUST hold the existing filesystem transaction lock throughout:
 * readStore -> clone BEFORE -> fn(proposed) -> enforceMutationLimits -> attach
 * returned mutation_limit_windows -> atomic write/rename. Roll back everything
 * on a thrown error. Resolve actorUserId from the verified server session.
 * Never catch a refusal and still commit, check outside the lock, use a
 * process-global counter, or offer HTTP callers a maintenance bypass.
 *
 * No actor is needed for transactions that do not write protected tables
 * (signup/session/profile maintenance). Protected writes without one fail closed.
 * Exact old-reference -> null cleanup for targets absent from the proposed
 * snapshot is a derived effect, not a no-session/association-field bypass.
 * This is a private development adapter, not a replacement for SQL/RLS.
 */
export function enforceMutationLimits(
  beforeSnapshot: object,
  proposedSnapshot: object,
  context: MutationLimitContext,
): LocalMutationLimitWindow[] {
  const before = beforeSnapshot as Snapshot
  const proposed = proposedSnapshot as Snapshot
  if (!Number.isSafeInteger(context.nowMs) || context.nowMs < 0) return invalidState()
  // Only this hook owns the ledger. A domain callback may not reset/edit it.
  if (!isDeepStrictEqual(before.mutation_limit_windows ?? [], proposed.mutation_limit_windows ?? [])) {
    return invalidState()
  }
  const ledger = ledgerFrom(before, context.nowMs)
  const charges = new Map<RateLimitBucket, number>()
  const previousReports = rowsById(before.reports)
  const nextReports = rowsById(proposed.reports)
  const previousActions = rowsById(before.moderation_actions)
  const nextActions = rowsById(proposed.moderation_actions)
  const auditedReports = new Set<string>()
  const decisionTargets = new Set<string>()
  const referenceTargetCache = new Map<string, Map<string, MutationRow>>()

  // A restore can append an audit while leaving an already-actioned report's
  // status unchanged. Charge each new report decision audit, and do not also
  // charge its report UPDATE. University audits (no report_id) are charged by
  // the university request review instead.
  for (const [id, action] of nextActions) {
    if (previousActions.has(id) || typeof action.report_id !== 'string' || !action.report_id) continue
    charges.set('moderation:decide', (charges.get('moderation:decide') ?? 0) + 1)
    auditedReports.add(action.report_id)
  }
  for (const [id, report] of nextReports) {
    const previous = previousReports.get(id)
    if (!auditedReports.has(id) &&
        (!previous || isDeepStrictEqual(projection(previous, []), projection(report, [])))) continue
    for (const [column, table] of Object.entries(REPORT_TARGETS)) {
      if (typeof report[column] === 'string' && report[column]) {
        decisionTargets.add(`${table}:${report[column]}`)
      }
    }
  }

  for (const [table, [insertBucket, ignored]] of Object.entries(TABLES)) {
    const previousRows = rowsById(before[table])
    const nextRows = rowsById(proposed[table])
    for (const [id, row] of nextRows) {
      const previous = previousRows.get(id)
      // Only the exact target of an already-charged report decision may omit
      // its derived moderation_status. Orphan moderation changes still spend
      // a write hit; actual body/title changes remain gated even during review.
      const projectedIgnores = [
        ...ignored,
        ...(previous ? derivedReferenceIgnores(table, previous, row, proposed, referenceTargetCache) : []),
        ...(decisionTargets.has(`${table}:${id}`) ? ['moderation_status'] : []),
      ]
      if (previous && isDeepStrictEqual(projection(previous, projectedIgnores), projection(row, projectedIgnores))) continue
      let bucket: RateLimitBucket = insertBucket
      if (previous) {
        if (table === 'reports') {
          if (auditedReports.has(id)) continue
          bucket = 'moderation:decide'
        }
        else if (table === 'bug_reports') bucket = 'bug:triage'
        else if (table === 'university_requests' &&
          ['status', 'reviewed_by', 'reviewed_at'].some(key =>
            !projectedIgnores.includes(key) && !isDeepStrictEqual(previous[key], row[key]),
          )) {
          bucket = 'moderation:university'
        }
      }
      charges.set(bucket, (charges.get(bucket) ?? 0) + 1)
    }
  }

  if (charges.size && !subjectIsValid(context.actorUserId)) {
    throw new Error('A protected local write requires a verified session user. Nothing was saved.')
  }
  // Stable ordering gives deterministic evidence and avoids future lock-order
  // differences if this hook is extended to another transactional backend.
  for (const [bucket, count] of [...charges].sort(([a], [b]) => compareKeys(a, b))) {
    const policy = RATE_LIMITS[bucket]
    const windowMs = policy.windowSeconds * 1000
    const start = Math.floor(context.nowMs / windowMs) * windowMs
    const subject = context.actorUserId!
    const id = `${bucket}:${subject}:${start}`
    const hits = (ledger.get(id)?.hits ?? 0) + count
    if (hits > policy.limit) {
      throw new MutationLimitError(bucket, Math.ceil((start + windowMs - context.nowMs) / 1000))
    }
    if (!ledger.has(id) && ledger.size >= MAX_WINDOWS) return invalidState()
    ledger.set(id, { id, bucket, subject, window_start_ms: start, hits })
  }
  return [...ledger.values()].sort((a, b) => compareKeys(a.id, b.id))
}
