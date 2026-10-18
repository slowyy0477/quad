import { describe, expect, it } from 'vitest'
import {
  eventHasPassed,
  formatEventDay,
  formatEventTime,
  formatEventWhen,
  safeZone,
  zonedToUtc,
} from './when'

/**
 * Event time is the one thing on this domain that is easy to get subtly wrong and hard to
 * notice afterwards: an hour out is invisible in review and obvious to the person who
 * turns up late. These assertions fix the arithmetic rather than the formatting taste.
 */
describe('wall clock to instant', () => {
  it('reads a Pakistani 14:30 as 09:30Z', () => {
    expect(zonedToUtc('2026-11-07T14:30', 'Asia/Karachi')?.toISOString()).toBe(
      '2026-11-07T09:30:00.000Z',
    )
  })

  it('applies the zone’s own daylight saving, not a fixed offset', () => {
    expect(zonedToUtc('2026-01-15T09:00', 'Europe/London')?.toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    )
    expect(zonedToUtc('2026-07-15T09:00', 'Europe/London')?.toISOString()).toBe(
      '2026-07-15T08:00:00.000Z',
    )
  })

  it('is the identity for UTC', () => {
    expect(zonedToUtc('2026-11-07T14:30', 'UTC')?.toISOString()).toBe('2026-11-07T14:30:00.000Z')
  })

  it('refuses anything that is not a wall-clock date and time', () => {
    for (const bad of ['', 'tomorrow', '2026-11-07', '2026-11-07T14', '07/11/2026 14:30']) {
      expect(zonedToUtc(bad, 'Asia/Karachi')).toBeNull()
    }
  })
})

describe('saying when', () => {
  const karachi = {
    startsAt: '2026-11-07T09:30:00Z',
    endsAt: '2026-11-07T11:00:00Z',
    timeZone: 'Asia/Karachi',
    isAllDay: false,
  }

  it('prints the organiser’s clock and names the zone', () => {
    expect(formatEventWhen(karachi)).toBe('Sat 7 Nov 2026 · 14:30–16:00 (Asia/Karachi)')
  })

  it('says all day without inventing a time', () => {
    expect(formatEventWhen({ ...karachi, isAllDay: true, endsAt: null })).toBe(
      'Sat 7 Nov 2026 · all day',
    )
  })

  it('prints both days when the event crosses midnight', () => {
    // 20:00 on the 7th to 01:00 on the 8th, Karachi time.
    expect(
      formatEventWhen({
        startsAt: '2026-11-07T15:00:00Z',
        endsAt: '2026-11-07T20:00:00Z',
        timeZone: 'Asia/Karachi',
        isAllDay: false,
      }),
    ).toBe('Sat 7 Nov 2026 20:00 – Sun 8 Nov 2026 01:00 (Asia/Karachi)')
  })

  it('falls back to a stated absence rather than a wrong date', () => {
    expect(formatEventWhen({ ...karachi, startsAt: 'not-a-date' })).toBe('Date to be confirmed')
    expect(formatEventDay('not-a-date', 'UTC')).toBe('Date to be confirmed')
    expect(formatEventTime('not-a-date', 'UTC')).toBe('')
  })

  it('names the zone in the list row too, where there is least room to explain', () => {
    expect(formatEventDay(karachi.startsAt, karachi.timeZone)).toBe('Sat 7 Nov 2026')
    expect(formatEventTime(karachi.startsAt, karachi.timeZone)).toBe('14:30 (Asia/Karachi)')
  })

  it('uses a zone the platform knows, or UTC', () => {
    expect(safeZone('Asia/Karachi')).toBe('Asia/Karachi')
    expect(safeZone('Mars/Olympus_Mons')).toBe('UTC')
    expect(safeZone(null)).toBe('Asia/Karachi')
  })
})

describe('past or upcoming', () => {
  it('compares instants against one clock', () => {
    const now = new Date('2026-11-07T10:00:00Z')
    expect(eventHasPassed('2026-11-07T09:59:00Z', now)).toBe(true)
    expect(eventHasPassed('2026-11-07T10:01:00Z', now)).toBe(false)
    expect(eventHasPassed('not-a-date', now)).toBe(false)
  })
})
