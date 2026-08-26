import { cn } from '@/lib/utils'

/**
 * Surface — a bordered panel.
 *
 * Named "surface" rather than "card" as a small act of discipline. The brief
 * called out interfaces where every section is a card; calling the primitive a
 * card invites exactly that, because a card is a thing you put content in, while
 * a surface is a thing you use when content genuinely needs separating from the
 * page.
 *
 * Most content on most pages should sit directly on the paper with a rule above
 * it. Reach for this when something is a discrete object -- a post, a project, a
 * form -- and not merely a paragraph that needed a box.
 */
export function Surface({
  className,
  as: Component = 'div',
  ...props
}: React.ComponentProps<'div'> & { as?: React.ElementType }) {
  return (
    <Component
      className={cn('rounded-md border border-hairline bg-paper-raised', className)}
      {...props}
    />
  )
}

/** A section heading with the rule that separates it from what came before. */
export function SectionHeading({
  title,
  description,
  action,
  className,
  level = 2,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  level?: 2 | 3
}) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3 pb-3', className)}>
      <div className="min-w-0 space-y-1">
        <Heading className={cn(level === 2 ? 'text-xl' : 'text-lg', 'text-ink')}>{title}</Heading>
        {description ? <p className="max-w-prose text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}

/**
 * Empty state.
 *
 * Deliberately says what is missing and what to do about it. "No results" alone
 * leaves the reader unsure whether they filtered too hard or the feature is
 * broken.
 */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-rule px-6 py-10 text-center',
        className,
      )}
    >
      <p className="font-display text-lg text-ink">{title}</p>
      {children ? (
        <div className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}
