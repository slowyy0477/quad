import { describe, expect, it } from 'vitest'
import {
  addDays,
  deadlineHasPassed,
  deadlineLabel,
  daysBetween,
  formatCalendarDate,
  opportunityIsClosed,
  todayInPakistan,
} from './board'
import {
  afterDeadlineFilter,
  boardNextCursor,
  closedLensFilter,
  decodeBoardCursor,
  encodeBoardCursor,
  UNDATED_SENTINEL,
} from './paging'

/**
 * These are the two pieces of the board that are logic rather than markup, and both have
 * a failure mode that is invisible on a happy path: a deadline sentence that is a day
 * out, and a cursor that skips or repeats a row at a page boundary.
 */
describe('deadline copy', () => {
  const today = '2026-10-18'

  it('counts calendar days, not hours', () => {
    expect(deadlineLabel('2026-10-18', today)).toBe('Closes today')
    expect(deadlineLabel('2026-10-19', today)).toBe('Closes tomorrow')
    expect(deadlineLabel('2026-10-21', today)).toBe('Closes in 3 days')
  })

  it('says how long ago a deadline went by rather than hiding it', () => {
    expect(deadlineLabel('2026-10-17', today)).toBe('Closed yesterday')
    expect(deadlineLabel('2026-10-11', today)).toBe('Closed 7 days ago')
  })

  it('does not invent urgency for a listing with no deadline', () => {
    expect(deadlineLabel(null, today)).toBe('No closing date')
    expect(deadlineHasPassed(null, today)).toBe(false)
  })

  it('crosses a month and a year boundary in whole days', () => {
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('one clock', () => {
  it('reads the Pakistani calendar day, not the UTC one', () => {
    // 20:30 UTC on the 18th is 01:30 on the 19th in Karachi. A UTC "today" would call a
    // deadline of the 19th "tomorrow" for a reader whose clock has already turned over.
    expect(todayInPakistan(new Date('2026-10-18T20:30:00Z'))).toBe('2026-10-19')
    expect(todayInPakistan(new Date('2026-10-18T18:30:00Z'))).toBe('2026-10-18')
  })
})

describe('closed or open', () => {
  it('treats either a poster’s status or a passed deadline as closed', () => {
    expect(opportunityIsClosed({ status: 'open', deadline: '2026-10-30' }, '2026-10-18')).toBe(false)
    expect(opportunityIsClosed({ status: 'open', deadline: '2026-10-17' }, '2026-10-18')).toBe(true)
    expect(opportunityIsClosed({ status: 'filled', deadline: '2026-12-01' }, '2026-10-18')).toBe(true)
    expect(opportunityIsClosed({ status: 'open', deadline: null }, '2026-10-18')).toBe(false)
  })

  it('formats a stored date without shifting it into another day', () => {
    // The column is a `date`. Reading it as a local midnight in a negative-offset zone
    // would print the 6th for a stored 7th, which is the classic date-column bug.
    expect(formatCalendarDate('2026-11-07')).toBe('7 Nov 2026')
    expect(formatCalendarDate(null)).toBeNull()
  })
})

describe('board cursor', () => {
  const row = { deadline: '2026-10-24', id: '0f2b6f3e-1f2a-4a2b-9c3d-7e5a1b2c3d4e' }

  it('round-trips a dated cursor', () => {
    expect(decodeBoardCursor(encodeBoardCursor(row))).toEqual(row)
  })

  it('round-trips the undated bucket, which is not a date a reader can see', () => {
    const undated = { deadline: null, id: row.id }
    expect(decodeBoardCursor(encodeBoardCursor(undated))).toEqual(undated)
    expect(encodeBoardCursor(undated)).not.toContain(UNDATED_SENTINEL)
  })

  it('keeps the id, because many listings share one deadline', () => {
    const a = encodeBoardCursor({ deadline: '2026-10-24', id: row.id })
    const b = encodeBoardCursor({ deadline: '2026-10-24', id: '11111111-2222-3333-4444-555555555555' })
    expect(a).not.toEqual(b)
  })

  it('falls back to the first page for anything mangled rather than erroring', () => {
    for (const bad of ['', 'nonsense', 'Zm9v', encodeBoardCursor(row).slice(0, 10), undefined]) {
      expect(decodeBoardCursor(bad)).toBeNull()
    }
  })

  it('canonicalises the date before it can reach a filter string', () => {
    const forged = Buffer.from(
      `2026-10-24T00:00:00+05:00|${row.id}`,
      'utf8',
    ).toString('base64url')
    expect(decodeBoardCursor(forged)?.deadline).toBe('2026-10-23')

    const injection = Buffer.from(`2026-10-24,id.eq.x|${row.id}`, 'utf8').toString('base64url')
    expect(decodeBoardCursor(injection)).toBeNull()
  })

  it('pages with a strict pair, so a shared deadline cannot repeat a row', () => {
    expect(afterDeadlineFilter(row)).toBe(
      `deadline.gt.2026-10-24,and(deadline.eq.2026-10-24,id.gt.${row.id})`,
    )
  })

  it('stops on a short page and continues on a full one', () => {
    const rows = [
      { deadline: '2026-10-20', id: row.id },
      { deadline: null, id: row.id },
    ]
    expect(boardNextCursor(rows, 5)).toBeNull()
    expect(boardNextCursor(rows, 2)).toEqual({ deadline: null, id: row.id })
    expect(boardNextCursor([], 5)).toBeNull()
  })
})

describe('closed lens filter', () => {
  const cursor = { createdAt: '2026-10-14T19:03:11.482Z', id: '0f2b6f3e-1f2a-4a2b-9c3d-7e5a1b2c3d4e' }

  it('names both ways a listing closes when there is no cursor', () => {
    expect(closedLensFilter('2026-10-18', null)).toBe(
      'status.neq.open,and(status.eq.open,deadline.lt.2026-10-18)',
    )
  })

  it('distributes the cursor so one `or` carries both predicates', () => {
    const filter = closedLensFilter('2026-10-18', cursor)

    // Four conjunctions: two ways to be closed times two ways to be past the cursor.
    expect(filter.match(/and\(/g)).toHaveLength(8)
    expect(filter).toContain(`and(status.neq.open,created_at.lt.${cursor.createdAt})`)
    expect(filter).toContain(
      `and(status.neq.open,and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`,
    )
    expect(filter).toContain(
      `and(and(status.eq.open,deadline.lt.2026-10-18),created_at.lt.${cursor.createdAt})`,
    )
    expect(filter).not.toContain(' ,')
  })
})
