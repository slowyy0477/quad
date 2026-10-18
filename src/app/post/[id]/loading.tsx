import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

export default function PostLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-4 h-3.5 w-28" />

      <div className="rounded-md border border-hairline bg-paper-raised p-4">
        <div className="flex gap-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-3">
            <Skeleton className="h-3.5 w-40" />
            <SkeletonText lines={4} />
            <div className="flex gap-4">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-16" />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-2 pb-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="space-y-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <SkeletonText lines={2} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
