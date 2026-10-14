import { cn } from '@/lib/utils'

/**
 * Skeleton — the shape of content that has not arrived.
 *
 * Not a spinner. A spinner says "something is happening"; a skeleton says "a list of
 * posts is coming, and here is where it will be", so the page does not jump when it
 * fills in. It is also the honest option: it shows structure we know we are fetching
 * rather than implying progress we are not measuring.
 *
 * The pulse is disabled by the reduced-motion block in globals.css, which is why this
 * carries no motion utility of its own.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-sm bg-paper-sunken', 'animate-pulse', className)}
      {...props}
    />
  )
}

/** A plausible block of text: full-width lines with a short last line. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  )
}

/** A post-shaped placeholder: avatar, name, two lines, action row. */
export function SkeletonPost() {
  return (
    <div className="flex gap-3 border-b border-hairline py-5" aria-hidden="true">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-3">
        <Skeleton className="h-3.5 w-40" />
        <SkeletonText lines={3} />
        <div className="flex gap-3">
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      </div>
    </div>
  )
}

/** A list placeholder, used by the `loading.tsx` files. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-hairline" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 py-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
