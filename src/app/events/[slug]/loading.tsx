import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

export default function EventDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="mt-4 h-9 w-3/4" />
      <Skeleton className="mt-3 h-6 w-64" />
      <div className="mt-6 rounded-md border border-hairline bg-paper-raised p-5">
        <div className="flex gap-6">
          <Skeleton className="h-12 w-20" />
          <Skeleton className="h-12 w-20" />
        </div>
        <Skeleton className="mt-5 h-2 w-full" />
      </div>
      <div className="mt-8 space-y-3">
        <Skeleton className="h-5 w-28" />
        <SkeletonText lines={5} />
      </div>
    </div>
  )
}
