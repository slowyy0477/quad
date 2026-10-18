import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

export default function SkillsLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-9 w-64" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <Skeleton className="mt-6 h-16 w-full" />
      <div className="mt-10">
        <Skeleton className="h-6 w-32" />
        <div className="mt-5 border-t border-hairline">
          <SkeletonList rows={4} />
        </div>
      </div>
    </div>
  )
}
