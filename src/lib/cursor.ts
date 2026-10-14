/**
 * Opaque cursors for keyset pagination.
 *
 * ARCHITECTURE §6 requires `(created_at, id)` keyset pagination everywhere that grows
 * without bound, and forbids offsets — an offset skips and duplicates rows exactly when
 * the list is busy enough to matter.
 *
 * The cursor is base64url so that a reader cannot edit it into something meaningful and
 * so that changing the shape later does not break a URL someone bookmarked. `id` is part
 * of the key on purpose: `created_at` alone is not unique, and a page boundary landing
 * between two rows written in the same millisecond silently repeats one of them forever.
 *
 * Server-side only (it uses `Buffer`), which is also where every cursor is produced and
 * consumed.
 */

export type Cursor = {
  /** ISO timestamp of the last row on the previous page. */
  createdAt: string
  /** Tiebreak: the id of the last row on the previous page. */
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url')
}

/**
 * Decode, or return null.
 *
 * Returning null rather than throwing is deliberate: a mangled cursor in a URL is a
 * reader's typo or a truncated share, not an attack. The caller shows the first page,
 * which is a better answer than an error page. What must never happen is the decoded
 * value reaching SQL unvalidated, so both halves are checked — a timestamp that parses
 * and an id that looks like a uuid — before either is used.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null

  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) return null

  const createdAt = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)

  if (!UUID.test(id)) return null
  if (Number.isNaN(Date.parse(createdAt))) return null

  return { createdAt, id }
}

/** The query-string form: `?cursor=…` arrives as string, string[] or undefined. */
export function parseCursor(value: string | string[] | undefined): Cursor | null {
  if (Array.isArray(value)) return decodeCursor(value[0])
  return decodeCursor(value)
}

/** The cursor for a page of rows, or null when the page is empty. */
export function nextCursor(rows: { created_at: string; id: string }[]): Cursor | null {
  const last = rows.at(-1)
  return last ? { createdAt: last.created_at, id: last.id } : null
}
