import { Skeleton } from '@/components/ui/skeleton'

/**
 * The bug form's loading state, in the shape of the form.
 *
 * Reserved space matters more here than on a feed: the reader has already decided
 * to help, and a page that pushes the first field down as it fills is a page where
 * somebody taps the wrong thing. The faint pulse is the only motion.
 */
export default function ReportABugLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2 pb-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      <div className="mt-6 rounded-md border border-hairline bg-paper-raised p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-40 w-full" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      <span className="sr-only">Loading the bug report form</span>
    </div>
  )
}
