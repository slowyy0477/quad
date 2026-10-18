import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

/**
 * The profile placeholder: avatar, name, the rule, then three sections. Nothing
 * here is content — it is the shape of what is being read, so the page does not
 * jump when it arrives.
 */
export default function ProfileLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        <Skeleton className="size-20 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
      </div>

      <div className="mt-8 flex gap-8 border-y border-hairline py-4">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-5 w-8" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-8">
        {[0, 1, 2].map((section) => (
          <div key={section} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    </div>
  )
}
