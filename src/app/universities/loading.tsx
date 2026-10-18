import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

/**
 * The institution list is a heading, a search field and a list of rows, so the
 * placeholder is the same shape. Nothing here claims progress we are not
 * measuring — it is the structure of what is being fetched.
 */
export default function UniversitiesLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <Skeleton className="mt-6 h-11 w-full" />
      <div className="mt-10">
        <Skeleton className="h-6 w-48" />
        <div className="mt-4 border-t border-hairline">
          <SkeletonList rows={6} />
        </div>
      </div>
    </div>
  )
}
