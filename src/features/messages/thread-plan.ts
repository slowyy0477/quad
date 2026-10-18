/**
 * The thread's render plan: day separators, the unread divider, and one row per
 * message.
 *
 * Pure, and separated from the component that draws it, because this is the part
 * with rules in it and rules are worth testing without a DOM. The dates are the
 * reason: a divider placed on the wrong side of midnight, or an unread marker
 * placed before a message the reader has already seen, is the kind of bug that
 * looks like nothing in a screenshot.
 *
 * `now` is a parameter rather than `new Date()` inside the function so a test can
 * stand at a fixed instant. Local calendar days are compared by their y/m/d
 * components, not by a fixed offset: "today" means the reader's day, and the
 * server renders this once, so the string that reaches the browser is already
 * decided and cannot disagree with itself after hydration.
 */

import { format } from 'date-fns'
import type { ThreadMessage } from './types'

export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: ThreadMessage; mine: boolean; time: string }

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** The reader's local calendar day of an instant, as a sortable key. */
export function dayKey(instant: string | Date): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(date.getTime())) return 'invalid'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * "Today", "Yesterday", or the date in full.
 *
 * `d MMMM yyyy` and not a relative phrase: "3 weeks ago" on a day separator tells
 * the reader less than the date does when they are scrolling back through a term.
 */
export function dayLabel(instant: string, now: Date): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return 'Undated'

  if (dayKey(date) === dayKey(now)) return 'Today'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday'

  return format(date, 'd MMMM yyyy')
}

/** The time of day, 24-hour, which is what the docs' British spelling implies. */
export function messageTime(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return ''
  return format(date, 'HH:mm')
}

/**
 * Turn a page of messages into the rows the thread draws.
 *
 * The unread divider is placed before the first message newer than
 * `last_read_at`. Three cases, and each is a decision:
 *
 *   * `last_read_at` is null — the row has never been stamped. Everything in the
 *     conversation is unread, so a divider would sit above the first message and
 *     mean nothing. None is drawn.
 *   * No message in this page is newer than `last_read_at` — the reader has
 *     already read this page, or has scrolled back into it. No divider.
 *   * Otherwise the divider goes exactly where the reader stopped reading, which
 *     is the promise the stored timestamp actually makes.
 */
export function buildThreadRenderPlan({
  messages,
  meId,
  lastReadAt,
  now,
}: {
  messages: ThreadMessage[]
  meId: string
  lastReadAt: string | null
  now: Date
}): ThreadRow[] {
  const rows: ThreadRow[] = []
  const readAt = lastReadAt ? Date.parse(lastReadAt) : Number.NaN
  let currentDay: string | null = null
  let dividerPlaced = false

  for (const message of messages) {
    const key = dayKey(message.created_at)

    if (key !== currentDay) {
      rows.push({ kind: 'day', key: `day-${key}`, label: dayLabel(message.created_at, now) })
      currentDay = key
    }

    if (!dividerPlaced && !Number.isNaN(readAt) && Date.parse(message.created_at) > readAt) {
      rows.push({ kind: 'unread', key: 'unread-divider' })
      dividerPlaced = true
    }

    rows.push({
      kind: 'message',
      key: message.id,
      message,
      mine: message.sender_id === meId,
      time: messageTime(message.created_at),
    })
  }

  return rows
}

/** "Ana", "Ana and Ben", "Ana, Ben and 3 others" — for a group's subtitle. */
export function describeParticipants(names: string[], max = 2): string {
  const unique = [...new Set(names.filter((name) => name.trim().length > 0))]
  if (unique.length === 0) return 'Nobody readable'
  if (unique.length <= max) {
    return unique.length === 1 ? unique[0]! : `${unique[0]} and ${unique[1]}`
  }
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} ${unique.length - max === 1 ? 'other' : 'others'}`
}
