import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

export default function OpportunityDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="mt-4 h-9 w-3/4" />
      <Skeleton className="mt-3 h-5 w-48" />
      <div className="mt-6 rounded-md border border-hairline bg-paper-raised p-5">
        <SkeletonText lines={4} />
      </div>
      <div className="mt-8 space-y-3">
        <Skeleton className="h-5 w-32" />
        <SkeletonText lines={6} />
      </div>
    </div>
  )
}
