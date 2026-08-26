import { cn } from '@/lib/utils'

/**
 * The wordmark.
 *
 * Drawn rather than set: four squares for the four sides of a quad, with the
 * courtyard left open in the middle. It is a shape a university student would
 * read as a building plan, which is more or less the idea.
 *
 * `aria-hidden` on the mark plus real text beside it means a screen reader gets
 * "Quad, link" instead of a description of a rectangle.
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg
        viewBox="0 0 24 24"
        className="size-6 shrink-0 text-accent-600"
        aria-hidden="true"
        fill="none"
      >
        <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" />
        <rect x="14.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" opacity="0.55" />
        <rect x="2.5" y="14.5" width="7" height="7" rx="1" fill="currentColor" opacity="0.55" />
        <rect x="14.5" y="14.5" width="7" height="7" rx="1" fill="currentColor" />
      </svg>
      {showWordmark ? (
        <span className="font-display text-lg font-semibold tracking-tight text-ink">Quad</span>
      ) : null}
    </span>
  )
}
