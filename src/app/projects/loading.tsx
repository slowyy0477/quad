import { SkeletonList } from '@/components/ui/skeleton'

export default function ProjectsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="space-y-2 pb-3">
        <div className="h-7 w-40 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
        <div className="h-4 w-80 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      </div>
      <div className="mt-5 h-9 w-64 animate-pulse rounded-sm bg-paper-sunken" aria-hidden="true" />
      <div className="mt-6 divide-y divide-hairline rounded-md border border-hairline bg-paper-raised px-4">
        <SkeletonList rows={5} />
      </div>
    </div>
  )
}
