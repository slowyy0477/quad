import { cn } from '@/lib/utils'

/**
 * StatRow — one number with its label.
 *
 * The number must come from stored rows. This component cannot enforce PRODUCT.md rule
 * 1, so it does the next best thing: it takes a `number` and not a string, which means
 * a caller cannot quietly pass "1.2k" or "—" and have it look like data. Formatting is
 * deliberately locale-free and exact: a university network is not an analytics
 * dashboard, and "1.2k members" is a rounded claim where "1,204 members" is a fact.
 *
 * `tabular` keeps a column of these aligned, which is the whole reason they sit in a row
 * rather than in sentences.
 */
export function StatRow({
  stats,
  className,
}: {
  stats: { label: string; value: number; hint?: string }[]
  className?: string
}) {
  return (
    <dl className={cn('flex flex-wrap gap-x-6 gap-y-3', className)}>
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">{stat.label}</dt>
          <dd className="mt-0.5 font-display text-lg text-ink tabular">{stat.value.toLocaleString('en-US')}</dd>
          {stat.hint ? <p className="text-xs text-ink-muted">{stat.hint}</p> : null}
        </div>
      ))}
    </dl>
  )
}

/**
 * A single inline number, for use in a sentence or a meta line.
 * Renders nothing at all when the value is zero and `hideZero` is set — an honest
 * absence beats a decorative "0 likes".
 */
export function Count({
  value,
  singular,
  plural,
  hideZero = false,
  className,
}: {
  value: number
  singular: string
  plural?: string
  hideZero?: boolean
  className?: string
}) {
  if (hideZero && value === 0) return null
  return (
    <span className={cn('tabular', className)}>
      {value.toLocaleString('en-US')} {value === 1 ? singular : (plural ?? `${singular}s`)}
    </span>
  )
}
