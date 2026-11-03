import 'server-only'

import { createHash } from 'node:crypto'
import type { Cursor } from '@/lib/cursor'
import { firstValue } from './filters'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_ID = /^[a-z0-9]+_[a-z0-9]{1,64}$/i
const UTC_DATE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/

export function validDiscoveryId(value: string, local: boolean): boolean {
  return UUID.test(value) || (local && LOCAL_ID.test(value))
}

/** Preserve Postgres microseconds; Date.toISOString alone would lose them. */
export function keysetDate(value: string): string | null {
  const match = UTC_DATE.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return null
  if (new Date(value).toISOString().slice(0, 19) !== match[1]) return null
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`
}

export function boundedPageSize(value: number | undefined, fallback = 20, max = 50): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}

/** Not a signature/permission grant: binds a position to one list's filters. */
export function keysetScope(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 22)
}

export function encodeKeysetCursor(cursor: Cursor, scope: string): string {
  return Buffer.from(JSON.stringify({
    v: 1, scope, at: keysetDate(cursor.createdAt), id: cursor.id,
  })).toString('base64url')
}

export function decodeKeysetCursor(
  raw: string | string[] | undefined,
  scope: string,
  local: boolean,
): Cursor | null {
  const value = firstValue(raw)
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) return null
    const payload: unknown = JSON.parse(decoded.toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const row = payload as Record<string, unknown>
    if (row.v !== 1 || row.scope !== scope || typeof row.at !== 'string' ||
      typeof row.id !== 'string' || !validDiscoveryId(row.id, local)) return null
    const createdAt = keysetDate(row.at)
    return createdAt ? { createdAt, id: row.id } : null
  } catch {
    return null
  }
}

export function newestFirst(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  const left = keysetDate(a.created_at) ?? ''
  const right = keysetDate(b.created_at) ?? ''
  if (left !== right) return left < right ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** The tuple survives removal/hiding of the previous page's boundary row. */
export function belowKeyset(row: { created_at: string; id: string }, cursor: Cursor): boolean {
  const at = keysetDate(row.created_at)
  return at !== null && (at < cursor.createdAt || (at === cursor.createdAt && row.id < cursor.id))
}

/** Only validated UTC timestamps and UUIDs may reach PostgREST filter syntax. */
export function hostedKeysetFilter(cursor: Cursor): string {
  const at = keysetDate(cursor.createdAt)
  if (!at || !UUID.test(cursor.id)) throw new Error('Invalid hosted keyset')
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`
}

export function keysetPage<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number,
  scope: string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > limit && last
      ? encodeKeysetCursor({ createdAt: last.created_at, id: last.id }, scope)
      : null,
  }
}
