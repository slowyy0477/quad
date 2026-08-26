import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Badge — a short factual label. Status, count, category.
 *
 * Not a button. If it is clickable it should look clickable, which means it is a
 * Button with `size="sm"`.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-hairline bg-paper-sunken text-ink-muted',
        accent: 'border-accent-200 bg-accent-50 text-accent-700',
        highlight: 'border-highlight-400/45 bg-highlight-100 text-highlight-700',
        danger: 'border-danger-600/30 bg-danger-50 text-danger-700',
        success: 'border-success-600/30 bg-success-50 text-success-600',
        outline: 'border-rule bg-transparent text-ink-muted',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
