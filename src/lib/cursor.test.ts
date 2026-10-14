import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, nextCursor, parseCursor, type Cursor } from './cursor'

/**
 * The cursor is the only thing standing between two pages of a feed, and two of its
 * properties are load-bearing: it must not be guessable into something meaningful, and a
 * mangled one must not throw (a truncated share link should show page one, not an error
 * page). Both are asserted here rather than assumed.
 */
const cursor: Cursor = { createdAt: '2026-10-14T19:03:11.482Z', id: '0f2b6f3e-1f2a-4a2b-9c3d-7e5a1b2c3d4e' }
const row = { created_at: cursor.createdAt, id: cursor.id }

describe('cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('keeps the id, because created_at alone is not unique', () => {
    const same = encodeCursor(cursor)
    const other = encodeCursor({ ...cursor, id: '11111111-2222-3333-4444-555555555555' })
    expect(same).not.toEqual(other)
  })

  it('is opaque: neither the timestamp nor the id is readable in the URL', () => {
    const encoded = encodeCursor(cursor)
    expect(encoded).not.toContain('2026')
    expect(encoded).not.toContain(cursor.id)
  })

  it('returns null rather than throwing for anything a reader mangles', () => {
    for (const bad of ['', 'nonsense', 'Zm9v', encodeCursor(cursor).slice(0, 12)]) {
      expect(decodeCursor(bad)).toBeNull()
    }
  })

  it('refuses a well-formed timestamp paired with an id that is not a uuid', () => {
    const forged = Buffer.from(`2026-10-14T00:00:00Z|1' or 1=1--`, 'utf8').toString('base64url')
    expect(decodeCursor(forged)).toBeNull()
  })

  it('refuses a uuid paired with something that is not a date', () => {
    const forged = Buffer.from(`not-a-date|${cursor.id}`, 'utf8').toString('base64url')
    expect(decodeCursor(forged)).toBeNull()
  })

  it('takes the first value when a parameter arrives twice', () => {
    expect(parseCursor([encodeCursor(cursor), 'nonsense'])).toEqual(cursor)
    expect(parseCursor(undefined)).toBeNull()
  })

  it('has no next cursor for an empty page, and the last row of a full one', () => {
    expect(nextCursor([])).toBeNull()
    expect(nextCursor([{ created_at: 'x', id: 'y' }, row])).toEqual(cursor)
  })
})
