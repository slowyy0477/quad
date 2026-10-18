import { Skeleton } from '@/components/ui/skeleton'

/**
 * The moderation queue's loading state.
 *
 * A skeleton in the shape of a queue row — a meta line, a block of quoted
 * content, a row of action buttons — so the page does not jump when it fills. The
 * queue is the one admin surface somebody checks between lectures on a phone, and
 * a layout that reflows under a thumb is how the wrong button gets pressed.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2 pb-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-4 w-56" />
      </div>

      <div className="space-y-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-md border border-hairline bg-paper-raised p-4 sm:p-5">
            <div className="flex gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-40" />
            </div>
            <Skeleton className="mt-4 h-24 w-full" />
            <div className="mt-4 flex gap-2 border-t border-rule pt-4">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>
        ))}
      </div>

      <span className="sr-only">Loading the moderation queue</span>
    </div>
  )
}
