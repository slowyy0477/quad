import { Skeleton, SkeletonPost } from '@/components/ui/skeleton'

/**
 * The feed's loading state.
 *
 * A skeleton rather than a spinner, and the same shape as the content that is
 * coming: on campus wifi the difference between "loading" and "broken" is
 * otherwise invisible, and a list that reflows as it fills is worse than one that
 * reserved the space.
 */
export default function FeedLoading() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-5">
        <div className="space-y-2 pb-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>

        <div className="rounded-md border border-hairline bg-paper-raised p-4">
          <Skeleton className="h-20 w-full" />
        </div>

        <div className="border-b border-rule">
          <div className="flex gap-1 pb-2">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        </div>

        <div>
          <SkeletonPost />
          <SkeletonPost />
          <SkeletonPost />
        </div>
      </div>

      <aside className="space-y-4 lg:border-l lg:border-hairline lg:pl-6">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-32" />
      </aside>
    </div>
  )
}
