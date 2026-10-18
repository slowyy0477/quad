import { decodeCursor, encodeCursor } from '@/lib/cursor'

/**
 * Pagination for the opportunity board.
 *
 * The board is ordered by `deadline`, which is not the `(created_at, id)` pair the
 * shared cursor was built for. The cursor format is reused rather than reinvented --
 * `lib/cursor` is what makes a cursor opaque, and a second base64 codec would be a
 * second thing to get wrong -- but the column it carries is a deadline.
 *
 * Two cursor states, because the column is nullable:
 *
 *   * `{ deadline: '2026-11-04', id }`  -- inside the dated rows, ascending;
 *   * `{ deadline: null, id }`          -- inside the undated rows, which sort last.
 *
 * `null` is encoded as a sentinel date. It only ever appears in the cursor, never in a
 * query, and `decodeBoardCursor` maps it back to `null` before anything builds a filter
 * from it.
 */

/** A date no listing can have, used to mark the cursor's position in the undated bucket. */
export const UNDATED_SENTINEL = '9999-12-31'

export type BoardCursor = {
  /** The last row's deadline, or `null` when the previous page ended among undated rows. */
  deadline: string | null
  id: string
}

export function encodeBoardCursor(cursor: BoardCursor): string {
  return encodeCursor({ createdAt: cursor.deadline ?? UNDATED_SENTINEL, id: cursor.id })
}

/**
 * Decode, or return `null`.
 *
 * Returning `null` means "show the first page", which is the same policy as
 * `lib/cursor`: a mangled cursor is a truncated share, not an attack. What matters here
 * is that the decoded value is *canonicalised to a calendar date* before it can reach a
 * PostgREST filter string. `decodeCursor` checks that the timestamp parses, and a value
 * that parses can still contain characters that mean something to PostgREST's filter
 * grammar, so the value is re-serialised from the parsed date rather than used as
 * received.
 */
export function decodeBoardCursor(raw: string | string[] | undefined): BoardCursor | null {
  const decoded = decodeCursor(Array.isArray(raw) ? raw[0] : raw)
  if (!decoded) return null
  if (decoded.createdAt === UNDATED_SENTINEL) return { deadline: null, id: decoded.id }

  const canonical = canonicalDate(decoded.createdAt)
  return canonical ? { deadline: canonical, id: decoded.id } : null
}

/** `YYYY-MM-DD` from anything Date can parse, or `null`. */
export function canonicalDate(value: string): string | null {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

/**
 * The filter for the next page of dated rows, ascending.
 *
 * `deadline.gt.D or (deadline = D and id > lastId)` -- the tiebreak exists because a
 * deadline is a date and dozens of listings share one, so `deadline` alone would repeat
 * or skip rows at every page boundary.
 */
export function afterDeadlineFilter(cursor: { deadline: string; id: string }): string {
  return `deadline.gt.${cursor.deadline},and(deadline.eq.${cursor.deadline},id.gt.${cursor.id})`
}

/**
 * The next page of the closed lens: newest posted first.
 *
 * The lens predicate and the cursor predicate are both disjunctions, and PostgREST
 * takes one `or` expression per query here, so the conjunction is distributed:
 *
 *   (A or B) and (C or D)  ==  (A and C) or (A and D) or (B and C) or (B and D)
 *
 * Four terms is the honest cost of paging a filtered disjunction, and it is cheaper
 * than a second round trip whose pages could disagree with the first.
 *
 * Closed means the poster closed or filled it, or the deadline went by. Both are
 * stored columns; neither is inferred.
 */
export function closedLensFilter(
  today: string,
  cursor: { createdAt: string; id: string } | null,
): string {
  const lens = ['status.neq.open', `and(status.eq.open,deadline.lt.${today})`]
  if (!cursor) return lens.join(',')

  const after = [
    `created_at.lt.${cursor.createdAt}`,
    `and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
  ]

  return lens
    .flatMap((term) => after.map((tail) => `and(${term},${tail})`))
    .join(',')
}

/**
 * The cursor for the next page, or `null` when this page was the last.
 *
 * A short page is the end: the query asked for `limit` rows and got fewer. `deadline:
 * null` on the last row means the page has entered the undated bucket, and the cursor
 * records that so the next request does not re-read the dated ones.
 */
export function boardNextCursor(
  rows: { deadline: string | null; id: string }[],
  limit: number,
): BoardCursor | null {
  if (rows.length < limit) return null
  const last = rows.at(-1)
  return last ? { deadline: last.deadline, id: last.id } : null
}
