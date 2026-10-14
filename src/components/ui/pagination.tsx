import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Cursor pagination, as links.
 *
 * ARCHITECTURE §6 requires keyset pagination everywhere that grows without bound, and
 * forbids offsets because an offset skips and duplicates rows when data shifts under the
 * reader. This is the interface half of that promise.
 *
 * It is a link rather than a button with a fetch on click, for three reasons: the next
 * page becomes a real URL you can middle-click, share or reload; it works before any
 * JavaScript loads; and there is no spinner that can lie about how much is left.
 *
 * `EndOfList` exists because "no more results" is information. An infinite spinner that
 * never resolves is the most common way a list lies to its reader.
 */
export function LoadMore({
  href,
  label = 'Load more',
  className,
}: {
  href: string
  label?: string
  className?: string
}) {
  return (
    <div className={cn('flex justify-center py-6', className)}>
      <Link
        href={href}
        scroll={false}
        rel="next"
        className={cn(
          'inline-flex min-h-11 items-center gap-2 rounded border border-rule bg-paper-raised px-4 text-sm font-medium text-ink',
          'hover:bg-paper-sunken',
        )}
      >
        {label}
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  )
}

export function EndOfList({ label = 'That is everything.', className }: { label?: string; className?: string }) {
  return (
    <p className={cn('py-6 text-center text-xs text-ink-faint', className)} role="status">
      {label}
    </p>
  )
}

/**
 * Build the href for the next page, keeping every other filter the reader set.
 *
 * Dropping the other parameters is the classic pagination bug: you filter by university,
 * scroll twice, and silently end up looking at the whole network again.
 */
export function cursorHref(
  basePath: string,
  params: Record<string, string | string[] | undefined>,
  cursor: string | null | undefined,
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === 'cursor' || value === undefined) continue
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v))
    else search.set(key, value)
  }
  if (cursor) search.set('cursor', cursor)
  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}
