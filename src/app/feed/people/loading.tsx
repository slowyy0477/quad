import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

export default function FeedPeopleLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="space-y-2 pb-3">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="mt-6">
        <SkeletonList rows={5} />
      </div>
    </div>
  )
}
