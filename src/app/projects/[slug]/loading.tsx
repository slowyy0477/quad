import { SkeletonList } from '@/components/ui/skeleton'

export default function ProjectDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="space-y-3">
        <div className="h-5 w-48 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
        <div className="h-9 w-2/3 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
        <div className="h-5 w-96 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      </div>
      <div className="mt-6 h-24 w-full animate-pulse rounded-md bg-paper-sunken" aria-hidden="true" />
      <div className="mt-8 space-y-3">
        <div className="h-6 w-40 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
        <div className="divide-y divide-hairline rounded-md border border-hairline bg-paper-raised px-4">
          <SkeletonList rows={3} />
        </div>
      </div>
    </div>
  )
}
