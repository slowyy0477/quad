/**
 * PROPOSAL ONLY, 2026-11-02. Not installed, executed, typechecked or linted.
 * Intended path after main's review: src/features/connections/graph-paging.ts.
 *
 * Pure position/codec helpers. No filesystem, environment, auth or provider
 * imports. Main's server-only adapter must independently authorize every read.
 */
import { Buffer } from 'node:buffer'
import type { ProfileSummary } from '@/features/profiles/queries'

export type GraphDirection = 'followers' | 'following' | 'connections'
export type GraphCursor = {
  subjectId: string
  direction: GraphDirection
  createdAt: string
  id: string
}
export type GraphItem = {
  id: string
  person: ProfileSummary
  created_at: string
  connectionId: string | null
}
export type GraphCounts = {
  follower_count: number
  following_count: number
  connection_count: number | null
}
export type GraphCursorResult<T> = { cursor: T | null; error: string | null }

export const GRAPH_CURSOR_ERROR = 'Invalid graph cursor.'
export const GRAPH_SCOPE_ERROR = 'This cursor belongs to a different graph list.'
export const GRAPH_DIRECTION_ERROR = 'Invalid graph direction.'
export const GRAPH_MAX_LIMIT = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_ID = /^[a-z0-9]+_[a-z0-9]{1,64}$/i
const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/

export function validGraphId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 &&
    value.trim() === value &&
    (UUID.test(value) || LOCAL_ID.test(value))
}

export function isGraphDirection(value: unknown): value is GraphDirection {
  return value === 'followers' || value === 'following' || value === 'connections'
}

/** Default 25; finite numeric fractions truncate, then clamp to 1..50. */
export function graphLimit(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 25
  return Math.max(1, Math.min(GRAPH_MAX_LIMIT, Math.trunc(value)))
}

/**
 * Normalize explicit-offset timestamps to six-digit UTC without rounding their
 * fractional seconds through Date. Date handles only whole-second calendar/
 * offset arithmetic; the exact 1..6 fractional digits are carried separately.
 * Accept ISO T and PostgreSQL space/+HH forms; refuse naive/invalid dates,
 * nonfinite values, leap seconds, >6 fractional digits and extended UTC years.
 */
export function normalizeGraphTime(value: string): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const match = TIME.exec(value)
  if (!match || match[0] !== value) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return null

  const wall = new Date(0)
  // setUTCFullYear avoids Date.UTC's special 1900 mapping for years 00..99.
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, second, 0)
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 ||
      wall.getUTCDate() !== day) return null

  const zone = match[8]!
  let offset = 0
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const offsetHours = Number(digits.slice(0, 2))
    const offsetMinutes = Number(digits.slice(2) || '0')
    if (offsetHours > 23 || offsetMinutes > 59) return null
    offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '+' ? 1 : -1)
  }
  const utc = new Date(wall.getTime() - offset * 60_000)
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) return null
  return `${utc.toISOString().slice(0, 19)}.${(match[7] ?? '').padEnd(6, '0')}Z`
}

/** UUID text order uses canonical lowercase; local opaque IDs keep exact case. */
function positionId(id: string): string {
  return UUID.test(id) ? id.toLowerCase() : id
}

export function compareGraphIds(left: string, right: string): number {
  const a = positionId(left)
  const b = positionId(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function readCursor(value: unknown): GraphCursorResult<GraphCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort().join(',')
  if (keys !== 'createdAt,direction,id,subjectId' ||
      !validGraphId(row.subjectId) || !validGraphId(row.id) ||
      !isGraphDirection(row.direction) || typeof row.createdAt !== 'string') {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  const createdAt = normalizeGraphTime(row.createdAt)
  return createdAt ? {
    cursor: {
      subjectId: positionId(row.subjectId),
      direction: row.direction,
      createdAt,
      id: positionId(row.id),
    },
    error: null,
  } : { cursor: null, error: GRAPH_CURSOR_ERROR }
}

/**
 * Both codec operations return {cursor,error}: here cursor is the encoded
 * string; in decode it is the normalized GraphCursor. Base64 is not authority.
 */
export function encodeGraphCursor(cursor: GraphCursor): GraphCursorResult<string> {
  const checked = readCursor(cursor)
  if (!checked.cursor) return { cursor: null, error: checked.error }
  return {
    cursor: Buffer.from(JSON.stringify({ v: 1, ...checked.cursor }), 'utf8')
      .toString('base64url'),
    error: null,
  }
}

export function decodeGraphCursor(
  raw: unknown,
  subjectId: string,
  direction: GraphDirection,
): GraphCursorResult<GraphCursor> {
  if (!validGraphId(subjectId) || !isGraphDirection(direction)) {
    return { cursor: null, error: GRAPH_SCOPE_ERROR }
  }
  // Only absence starts a first page. Present-but-empty/array input is malformed.
  if (raw === undefined || raw === null) return { cursor: null, error: null }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  let payload: unknown
  try {
    const bytes = Buffer.from(raw, 'base64url')
    const text = bytes.toString('utf8')
    if (bytes.toString('base64url') !== raw ||
        !Buffer.from(text, 'utf8').equals(bytes)) {
      return { cursor: null, error: GRAPH_CURSOR_ERROR }
    }
    payload = JSON.parse(text)
  } catch {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  const row = payload as Record<string, unknown>
  if (row.v !== 1 || Object.keys(row).sort().join(',') !==
      'createdAt,direction,id,subjectId,v') {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
  const checked = readCursor({
    subjectId: row.subjectId, direction: row.direction,
    createdAt: row.createdAt, id: row.id,
  })
  if (!checked.cursor) return checked
  if (checked.cursor.subjectId !== positionId(subjectId) ||
      checked.cursor.direction !== direction) {
    return { cursor: null, error: GRAPH_SCOPE_ERROR }
  }
  return checked
}
