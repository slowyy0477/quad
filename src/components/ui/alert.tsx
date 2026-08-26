import { cva, type VariantProps } from 'class-variance-authority'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Alert — an inline message about the page or a form.
 *
 * Each tone carries an icon as well as a colour, because colour alone is not a
 * distinction for a red-green colourblind reader, and it is not a distinction at
 * all in a high-contrast forced-colours mode.
 *
 * `role` matters and is not the same for every tone. A danger or warning alert
 * that appears after an action needs to be announced immediately (`alert`);
 * standing informational text should not interrupt whatever is being read
 * (`status`). Callers can override when they know better.
 */
const alertVariants = cva('flex gap-3 rounded border px-3.5 py-3 text-sm', {
  variants: {
    tone: {
      info: 'border-rule bg-paper-sunken text-ink',
      success: 'border-success-600/35 bg-success-50 text-ink',
      warning: 'border-warning-600/40 bg-warning-50 text-ink',
      danger: 'border-danger-600/40 bg-danger-50 text-ink',
    },
  },
  defaultVariants: { tone: 'info' },
})

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const

const iconTint = {
  info: 'text-ink-muted',
  success: 'text-success-600',
  warning: 'text-warning-600',
  danger: 'text-danger-600',
} as const

export type AlertProps = React.ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    title?: string
  }

export function Alert({ className, tone = 'info', title, children, role, ...props }: AlertProps) {
  const key = tone ?? 'info'
  const Icon = icons[key]

  return (
    <div
      role={role ?? (key === 'danger' || key === 'warning' ? 'alert' : 'status')}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconTint[key])} aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-ink-muted [&_a]:text-accent-700 [&_a]:underline">{children}</div> : null}
      </div>
    </div>
  )
}
