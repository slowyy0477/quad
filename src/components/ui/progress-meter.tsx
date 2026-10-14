import { cn } from '@/lib/utils'

/**
 * ProgressMeter — a fraction that exists in the data.
 *
 * Only render this when both the completed and the total are rows you can point at. A
 * goal with three milestones, four courses in a semester, two of three collaborators
 * found: those are facts. "Profile completeness 60%" is not, and a meter drawn from a
 * weight someone invented in a component teaches the user to distrust every other
 * meter on the site.
 *
 * `aria-valuenow` is set from the real numbers rather than from the rendered width, so
 * a screen reader hears the value rather than the CSS.
 */
export function ProgressMeter({
  value,
  total,
  label,
  className,
  tone = 'accent',
}: {
  value: number
  total: number
  label?: string
  className?: string
  tone?: 'accent' | 'success'
}) {
  if (total <= 0) return null
  const clamped = Math.max(0, Math.min(value, total))
  const percent = Math.round((clamped / total) * 100)

  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-ink-muted">{label}</span>
          <span className="text-ink-muted tabular">
            {clamped} / {total}
          </span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label ?? `${percent}% complete`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-paper-sunken"
      >
        <div
          className={cn('h-full rounded-full', tone === 'success' ? 'bg-success-600' : 'bg-accent-600')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
