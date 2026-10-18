import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Offset pagination for the admin tables.
 *
 * ARCHITECTURE §6 allows offsets for admin tables and only for admin tables: a
 * moderator queue or an audit log is a bounded list somebody works through, and a
 * page number is more useful there than a cursor. Feeds and profiles use cursors
 * (src/lib/cursor.ts) because they are unbounded and written to while read.
 *
 * `readPage` lives here rather than in the pages so that a nonsense `?page=` is
 * handled the same way in all four of them. Keeping it next to the component that
 * renders the result also keeps the two halves of the same idea in one file.
 */

/** `?page=` as a page number: 1-based, and 1 for anything unparseable. */
export function readPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return parsed
}

/** How many pages a total makes, for the "page 2 of 7" line. */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage))
}

function href(basePath: string, params: Record<string, string | undefined>, page: number): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  if (page > 1) search.set('page', String(page))
  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}

export function AdminPager({
  basePath,
  page,
  perPage,
  total,
  /** Filters to carry across page changes, so paging does not drop them. */
  params = {},
  className,
}: {
  basePath: string
  page: number
  perPage: number
  total: number
  params?: Record<string, string | undefined>
  className?: string
}) {
  const last = pageCount(total, perPage)
  if (last <= 1) return null

  const itemClass =
    'inline-flex min-h-11 items-center rounded border border-rule px-3 text-sm text-ink hover:border-ink-faint'

  return (
    <nav
      aria-label="Pages"
      className={cn('flex flex-wrap items-center justify-between gap-3 pt-2', className)}
    >
      {page > 1 ? (
        <Link href={href(basePath, params, page - 1)} className={itemClass} rel="prev">
          Newer
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}

      <p className="text-xs text-ink-muted">
        Page <span className="tabular">{page}</span> of <span className="tabular">{last}</span> ·{' '}
        <span className="tabular">{total}</span> in total
      </p>

      {page < last ? (
        <Link href={href(basePath, params, page + 1)} className={itemClass} rel="next">
          Older
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  )
}
