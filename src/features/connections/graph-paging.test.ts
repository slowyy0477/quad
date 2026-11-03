/**
 * PROPOSAL ONLY, 2026-11-02. Authored, NOT RUN/typechecked/linted.
 * Intended path: src/features/connections/graph-paging.test.ts.
 * Pure codec/calendar cases; no app, datastore, browser or provider runtime.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  compareGraphIds, decodeGraphCursor, encodeGraphCursor, graphLimit,
  GRAPH_CURSOR_ERROR, GRAPH_SCOPE_ERROR, isGraphDirection, normalizeGraphTime,
  validGraphId, type GraphCursor, type GraphDirection,
} from './graph-paging'

const position: GraphCursor = {
  subjectId: 'prf_subject',
  direction: 'followers',
  createdAt: '2026-11-02T07:00:00.123456Z',
  id: 'prf_alpha',
}

function token(cursor: GraphCursor = position): string {
  const result = encodeGraphCursor(cursor)
  expect(result.error).toBeNull()
  if (result.cursor === null) throw new Error('Valid fixture cursor was refused.')
  return result.cursor
}

function payload(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error('Fixture payload must be serializable.')
  return Buffer.from(text, 'utf8').toString('base64url')
}

describe('graphLimit', () => {
  it.each([
    [undefined, 25], [0, 1], [-100, 1], [0.9, 1], [1.9, 1],
    [25.9, 25], [50, 50], [50.9, 50], [10_000, 50],
    [Number.NaN, 25], [Number.POSITIVE_INFINITY, 25], [Number.NEGATIVE_INFINITY, 25],
  ])('normalizes numeric %s to %s', (input, expected) => {
    expect(graphLimit(input)).toBe(expected)
  })

  it.each(['25', '', null, {}, []])('does not coerce nonnumeric input %j', input => {
    expect(graphLimit(input as unknown as number)).toBe(25)
  })
})

describe('normalizeGraphTime', () => {
  it.each([
    ['2026-11-02T07:00:00Z', '2026-11-02T07:00:00.000000Z'],
    ['2026-11-02T07:00:00.1Z', '2026-11-02T07:00:00.100000Z'],
    ['2026-11-02T07:00:00.123Z', '2026-11-02T07:00:00.123000Z'],
    ['2026-11-02T07:00:00.123455Z', '2026-11-02T07:00:00.123455Z'],
    ['2026-11-02T07:00:00.123456Z', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02T07:00:00.123457Z', '2026-11-02T07:00:00.123457Z'],
    ['2026-11-02 07:00:00.123456+00', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02 07:00:00.123456+0000', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02 07:00:00.123456+00:00', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02T12:00:00.123456+05:00', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02T12:30:00.123456+0530', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02 02:00:00.123456-05', '2026-11-02T07:00:00.123456Z'],
    ['2026-11-02T03:30:00.123456-03:30', '2026-11-02T07:00:00.123456Z'],
    ['2026-01-01T00:15:00.000001+01:00', '2025-12-31T23:15:00.000001Z'],
    ['2025-12-31T23:45:00.999999-01:00', '2026-01-01T00:45:00.999999Z'],
    ['2024-03-01T00:15:00.123456+01:00', '2024-02-29T23:15:00.123456Z'],
    ['2000-02-29T12:00:00Z', '2000-02-29T12:00:00.000000Z'],
    ['0099-01-01T00:00:00.123456Z', '0099-01-01T00:00:00.123456Z'],
    ['0001-01-01T00:30:00+00:30', '0001-01-01T00:00:00.000000Z'],
  ])('keeps the exact UTC position for %s', (input, expected) => {
    expect(normalizeGraphTime(input)).toBe(expected)
  })

  it.each([
    '', 'not-a-time', '2026-11-02T07:00:00', '2026-11-02 07:00:00',
    '2026-11-02', '2026-11-02T07:00:00z', '2026-11-02T07:00:00.Z',
    '2026-11-02T07:00:00.1234567Z', '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-11-00T00:00:00Z', '2026-11-02T24:00:00Z',
    '2026-11-02T07:60:00Z', '2026-11-02T07:00:60Z',
    '2026-11-02T07:00:00+24:00', '2026-11-02T07:00:00+05:60',
    '2026-11-02T07:00:00+05:00:00', '0000-01-01T00:00:00Z',
    '0001-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
    '+010000-01-01T00:00:00Z', ' 2026-11-02T07:00:00Z',
    '2026-11-02T07:00:00Z ', '2026-11-02T07:00:00Z\n',
    '2026-11-02T07:00:00Z\r\n',
  ])('refuses malformed, lossy or non-UTC-resolvable input %j', input => {
    expect(normalizeGraphTime(input)).toBeNull()
  })

  it.each([null, undefined, 0, new Date('2026-11-02T07:00:00Z')])(
    'refuses nonstring input %j', input => {
      expect(normalizeGraphTime(input as unknown as string)).toBeNull()
    },
  )

  it('does not collapse adjacent microseconds into a millisecond position', () => {
    const before = normalizeGraphTime('2026-11-02T12:00:00.123455+05')
    const at = normalizeGraphTime('2026-11-02T07:00:00.123456Z')
    const after = normalizeGraphTime('2026-11-02 02:00:00.123457-05')
    expect([before, at, after]).toEqual([
      '2026-11-02T07:00:00.123455Z',
      '2026-11-02T07:00:00.123456Z',
      '2026-11-02T07:00:00.123457Z',
    ])
    expect(before! < at! && at! < after!).toBe(true)
  })
})

describe('graph identifiers and direction', () => {
  it.each(['prf_alpha', 'con_001', 'fol_Z9', 'A0000000-0000-0000-0000-000000000001'])(
    'accepts a supported exact identifier %s', id => {
      expect(validGraphId(id)).toBe(true)
    },
  )

  it.each(['', 'alpha', 'prf_', 'prf_alpha_beta', 'prf_alpha-', ' prf_alpha',
    'prf_alpha\n', 'prf_alpha\r\n', 'prf_alpha ', `prf_${'x'.repeat(65)}`, null, 12])(
    'refuses an unsupported or whitespace identifier %j', id => {
      expect(validGraphId(id)).toBe(false)
    },
  )

  it('compares canonical UUIDs but keeps local opaque identifiers case-sensitive', () => {
    expect(compareGraphIds(
      'A0000000-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-000000000001',
    )).toBe(0)
    expect(compareGraphIds('prf_B', 'prf_a')).toBe(-1)
    expect(compareGraphIds('con_002', 'con_001')).toBe(1)
  })

  it('allows exactly the three list directions', () => {
    for (const direction of ['followers', 'following', 'connections']) {
      expect(isGraphDirection(direction)).toBe(true)
    }
    for (const direction of ['requests', 'blocked', 'Followers', '', null]) {
      expect(isGraphDirection(direction)).toBe(false)
    }
  })
})

describe('graph cursor envelope', () => {
  it.each(['followers', 'following', 'connections'] as const)(
    'round-trips the exact %s tuple and distinguishes encoded/decoded results', direction => {
      const cursor = { ...position, direction, id: direction === 'connections' ? 'con_001' : 'prf_alpha' }
      const encoded = encodeGraphCursor(cursor)
      expect(encoded).toEqual({ cursor: token(cursor), error: null })
      expect(decodeGraphCursor(encoded.cursor, cursor.subjectId, direction))
        .toEqual({ cursor, error: null })
    },
  )

  it('normalizes offset timestamps and UUID casing without mutating input', () => {
    const cursor = Object.freeze({
      ...position,
      subjectId: 'A0000000-0000-0000-0000-000000000001',
      id: 'B0000000-0000-0000-0000-000000000002',
      createdAt: '2026-11-02 12:00:00.123456+05',
    })
    const encoded = token(cursor)
    expect(decodeGraphCursor(encoded, cursor.subjectId.toLowerCase(), cursor.direction)).toEqual({
      cursor: {
        ...cursor,
        subjectId: cursor.subjectId.toLowerCase(),
        id: cursor.id.toLowerCase(),
        createdAt: position.createdAt,
      },
      error: null,
    })
    expect(cursor.createdAt).toBe('2026-11-02 12:00:00.123456+05')
    expect(cursor.id.startsWith('B')).toBe(true)
  })

  it.each([null, undefined])('only treats absence %s as a first page', raw => {
    expect(decodeGraphCursor(raw, position.subjectId, position.direction))
      .toEqual({ cursor: null, error: null })
  })

  it('returns scope errors for foreign subject, direction and unsupported requested scope', () => {
    const raw = token()
    for (const [subjectId, direction] of [
      ['prf_other', 'followers'], ['prf_subject', 'following'],
      ['bad-id', 'followers'], ['prf_subject', 'requests'],
    ]) {
      expect(decodeGraphCursor(raw, subjectId, direction as GraphDirection))
        .toEqual({ cursor: null, error: GRAPH_SCOPE_ERROR })
    }
    expect(decodeGraphCursor(undefined, 'prf_subject', 'requests' as GraphDirection))
      .toEqual({ cursor: null, error: GRAPH_SCOPE_ERROR })
  })

  it('does not conflate malformed input with absence or an empty list', () => {
    const raw = token()
    for (const input of [
      '', ' ', [], [raw], {}, 5, `${raw}=`, `${raw}\n`, '+/', 'A', 'Zh',
      'x'.repeat(1025),
      Buffer.from([0xc3, 0x28]).toString('base64url'),
      Buffer.from('not JSON', 'utf8').toString('base64url'),
    ]) {
      expect(decodeGraphCursor(input, position.subjectId, position.direction))
        .toEqual({ cursor: null, error: GRAPH_CURSOR_ERROR })
    }
  })

  it('rejects unsupported versions, extra/missing keys and invalid payload tuples', () => {
    const valid = { v: 1, ...position }
    const { id: omittedId, ...missingId } = valid
    expect(omittedId).toBe(position.id)
    for (const input of [
      null, [], 12, 'cursor', { ...valid, v: 2 }, { ...valid, v: '1' },
      { ...valid, total: 9000 }, missingId,
      { ...valid, id: '' }, { ...valid, subjectId: 'prf_subject\n' },
      { ...valid, direction: 'blocked' }, { ...valid, createdAt: '2026-02-30T00:00:00Z' },
      { ...valid, createdAt: '2026-11-02T07:00:00.1234567Z' },
    ]) {
      expect(decodeGraphCursor(payload(input), position.subjectId, position.direction))
        .toEqual({ cursor: null, error: GRAPH_CURSOR_ERROR })
    }
  })

  it('refuses bad authoring tuples at encoding rather than producing a success token', () => {
    for (const input of [
      { ...position, id: 'broken' },
      { ...position, createdAt: '2026-11-02T07:00:00' },
      { ...position, direction: 'requests' },
      { ...position, extra: true },
    ]) {
      expect(encodeGraphCursor(input as GraphCursor))
        .toEqual({ cursor: null, error: GRAPH_CURSOR_ERROR })
    }
  })
})
