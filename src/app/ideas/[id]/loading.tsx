import { SkeletonList } from '@/components/ui/skeleton'

export default function IdeaDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="h-5 w-40 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      <div className="mt-3 h-9 w-2/3 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      <div className="mt-4 h-5 w-56 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      <div className="mt-6 h-28 w-full animate-pulse rounded-md bg-paper-sunken" aria-hidden="true" />
      <div className="mt-8 divide-y divide-hairline rounded-md border border-hairline bg-paper-raised px-4">
        <SkeletonList rows={3} />
      </div>
    </div>
  )
}
