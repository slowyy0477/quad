import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

/**
 * The section bar is drawn immediately — it is links, not data — and the lists
 * below it are skeletons. This boundary is on `/connections` and therefore covers
 * its three child sections too, which is why it is generic.
 */
export default function ConnectionsLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <div className="mt-6 flex gap-4 border-b border-rule pb-3">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-4 w-20" />
        ))}
      </div>
      <div className="mt-8">
        <Skeleton className="h-6 w-56" />
        <div className="mt-4 border-t border-hairline">
          <SkeletonList rows={5} />
        </div>
      </div>
    </div>
  )
}
