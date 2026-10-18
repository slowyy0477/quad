import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

export default function EventsLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="space-y-2 pb-3">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="mt-5 flex gap-1 border-b border-rule pb-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Skeleton className="h-16 w-48" />
        <Skeleton className="h-16 w-40" />
      </div>
      <div className="mt-6 space-y-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="rounded-md border border-hairline bg-paper-raised px-4 py-2">
            <SkeletonList rows={1} />
          </div>
        ))}
      </div>
    </div>
  )
}
