import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

/**
 * The search route's loading state.
 *
 * The same shape as the page that is coming — heading, field, tab strip, rows — so
 * that a search on campus wifi does not look like a search that did nothing. The tab
 * strip is drawn as six short blocks because that is what arrives, and the rows are
 * list-shaped because most searches are for a person.
 */
export default function SearchLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <div className="space-y-2 pb-3">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80" />
      </div>

      <Skeleton className="mt-5 h-11 w-full" />

      <div className="mt-6 border-b border-rule pb-2">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-6 w-20" />
          ))}
        </div>
      </div>

      <div className="mt-4">
        <SkeletonList rows={4} />
      </div>
    </div>
  )
}
