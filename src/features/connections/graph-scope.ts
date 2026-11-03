import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  decodeGraphCursor, encodeGraphCursor, GRAPH_CURSOR_ERROR, GRAPH_SCOPE_ERROR,
  type GraphCursor, type GraphCursorResult, type GraphDirection,
} from './graph-paging'

export type GraphScope = {
  provider: 'local' | 'supabase'
  viewerId: string | null
  subjectId: string
  direction: GraphDirection
}

function scopeKey(scope: GraphScope): string {
  return createHash('sha256').update(JSON.stringify([
    scope.provider, scope.viewerId, scope.subjectId, scope.direction,
  ])).digest('base64url')
}

/** A scoped position, not a credential. Every server read still authorizes afresh. */
export function encodeScopedGraphCursor(
  cursor: GraphCursor, scope: GraphScope,
): GraphCursorResult<string> {
  const inner = encodeGraphCursor(cursor)
  if (!inner.cursor) return inner
  const verified = decodeGraphCursor(inner.cursor, scope.subjectId, scope.direction)
  if (!verified.cursor) return { cursor: null, error: verified.error }
  return {
    cursor: Buffer.from(JSON.stringify({ v: 1, scope: scopeKey(scope), position: inner.cursor }))
      .toString('base64url'),
    error: null,
  }
}

export function decodeScopedGraphCursor(
  raw: unknown, scope: GraphScope,
): GraphCursorResult<GraphCursor> {
  if (raw === undefined || raw === null) return { cursor: null, error: null }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return { cursor: null, error: GRAPH_CURSOR_ERROR }
  try {
    const bytes = Buffer.from(raw, 'base64url')
    const text = bytes.toString('utf8')
    if (bytes.toString('base64url') !== raw || !Buffer.from(text).equals(bytes)) {
      return { cursor: null, error: GRAPH_CURSOR_ERROR }
    }
    const row: unknown = JSON.parse(text)
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { cursor: null, error: GRAPH_CURSOR_ERROR }
    }
    const value = row as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'position,scope,v' || value.v !== 1 ||
        typeof value.scope !== 'string' || typeof value.position !== 'string') {
      return { cursor: null, error: GRAPH_CURSOR_ERROR }
    }
    if (value.scope !== scopeKey(scope)) return { cursor: null, error: GRAPH_SCOPE_ERROR }
    return decodeGraphCursor(value.position, scope.subjectId, scope.direction)
  } catch {
    return { cursor: null, error: GRAPH_CURSOR_ERROR }
  }
}
