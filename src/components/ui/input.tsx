import { cn } from '@/lib/utils'

/**
 * Text inputs.
 *
 * `aria-invalid` drives the error styling rather than a separate `error` prop.
 * That way the visual state and the state announced to assistive technology can
 * never disagree -- there is only one flag, and it is the accessible one.
 *
 * Font size is 16px on small screens (`text-base`) and 14px from `sm` up. Mobile
 * Safari zooms the viewport when a focused input's text is under 16px, and the
 * page never zooms back out.
 */
const fieldClasses = cn(
  'w-full rounded border border-rule bg-paper-raised px-3 text-base text-ink',
  'placeholder:text-ink-faint',
  'transition-colors duration-150',
  'hover:border-ink-faint',
  'focus-visible:border-accent-600 focus-visible:outline-accent-600',
  'disabled:cursor-not-allowed disabled:bg-paper-sunken disabled:text-ink-faint',
  'aria-invalid:border-danger-600 aria-invalid:focus-visible:outline-danger-600',
  'sm:text-sm',
)

export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return <input type={type} className={cn(fieldClasses, 'min-h-11 sm:min-h-10', className)} {...props} />
}

export function Textarea({ className, rows = 4, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea rows={rows} className={cn(fieldClasses, 'py-2.5 leading-relaxed', className)} {...props} />
}

export function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(fieldClasses, 'min-h-11 appearance-none pr-9 sm:min-h-10', className)}
      {...props}
    />
  )
}

export { fieldClasses }
