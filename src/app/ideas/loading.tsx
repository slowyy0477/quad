import { SkeletonList } from '@/components/ui/skeleton'

export default function IdeasLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="space-y-2 pb-3">
        <div className="h-7 w-32 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
        <div className="h-4 w-96 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      </div>
      <div className="mt-5 h-12 w-full animate-pulse rounded-md bg-paper-sunken" aria-hidden="true" />
      <div className="mt-6 divide-y divide-hairline rounded-md border border-hairline bg-paper-raised px-4">
        <SkeletonList rows={4} />
      </div>
    </div>
  )
}
