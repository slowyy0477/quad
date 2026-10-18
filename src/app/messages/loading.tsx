import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

/**
 * The messages loading state.
 *
 * The same two-column shape as the content that is coming, at the same sizes, so
 * the page does not jump when the rows arrive — which, on campus wifi, is the
 * difference between "loading" and "broken".
 */
export default function MessagesLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl pb-16 sm:px-6 sm:pb-8">
      <div className="space-y-2 px-3 pt-6 pb-3 sm:px-0">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="grid gap-0 md:grid-cols-[20rem_minmax(0,1fr)] md:gap-6">
        <aside className="min-w-0 border-hairline md:border-r md:pr-4">
          <div className="space-y-2 border-b border-hairline px-3 py-3">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="px-3">
            <SkeletonList rows={6} />
          </div>
        </aside>

        <div className="hidden min-w-0 md:block md:pl-4">
          <div className="space-y-3 px-3 py-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-3/5" />
            <Skeleton className="h-16 w-2/5" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
