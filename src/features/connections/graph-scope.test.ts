import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeScopedGraphCursor, encodeScopedGraphCursor, type GraphScope } from './graph-scope'
import { encodeGraphCursor } from './graph-paging'

const scope: GraphScope = {
  provider: 'local', viewerId: 'prf_reader', subjectId: 'prf_subject', direction: 'followers',
}
const position = {
  subjectId: scope.subjectId, direction: scope.direction,
  createdAt: '2026-11-02T10:20:30.123456Z', id: 'prf_boundary',
}

describe('provider, reader and list bound graph positions', () => {
  it('preserves all microseconds and round-trips without publishing the reader ID', () => {
    const encoded = encodeScopedGraphCursor(position, scope)
    expect(encoded.error).toBeNull()
    expect(encoded.cursor).not.toBeNull()
    expect(Buffer.from(encoded.cursor!, 'base64url').toString()).not.toContain(scope.viewerId!)
    expect(decodeScopedGraphCursor(encoded.cursor, scope)).toEqual({ cursor: position, error: null })
  })

  it.each([
    { provider: 'supabase' as const },
    { viewerId: 'prf_otherreader' },
    { viewerId: null },
    { subjectId: 'prf_othersubject' },
    { direction: 'following' as const },
    { direction: 'connections' as const },
  ])('rejects a position reused with a different scope: %j', changed => {
    const encoded = encodeScopedGraphCursor(position, scope).cursor!
    expect(decodeScopedGraphCursor(encoded, { ...scope, ...changed }))
      .toEqual({ cursor: null, error: 'This cursor belongs to a different graph list.' })
  })

  it.each([undefined, null])('only absence starts a fresh page: %s', raw => {
    expect(decodeScopedGraphCursor(raw, scope)).toEqual({ cursor: null, error: null })
  })

  it.each(['', [], ['abc'], {}, 0, 'abc=', 'a', 'x'.repeat(2049)])('rejects malformed envelope input: %j', raw => {
    expect(decodeScopedGraphCursor(raw, scope)).toEqual({ cursor: null, error: 'Invalid graph cursor.' })
  })

  it('refuses an unscoped tuple and mismatched nested direction', () => {
    expect(decodeScopedGraphCursor(encodeGraphCursor(position).cursor, scope).error)
      .toBe('Invalid graph cursor.')
    expect(encodeScopedGraphCursor({ ...position, direction: 'following' }, scope))
      .toEqual({ cursor: null, error: 'This cursor belongs to a different graph list.' })
  })

  it('refuses unsupported versions, extra keys, and invalid UTF-8', () => {
    const encoded = encodeScopedGraphCursor(position, scope).cursor!
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Record<string, unknown>
    for (const value of [{ ...envelope, v: 2 }, { ...envelope, extra: true }]) {
      expect(decodeScopedGraphCursor(Buffer.from(JSON.stringify(value)).toString('base64url'), scope).error)
        .toBe('Invalid graph cursor.')
    }
    expect(decodeScopedGraphCursor(Buffer.from([0xff, 0x80]).toString('base64url'), scope).error)
      .toBe('Invalid graph cursor.')
  })
})
