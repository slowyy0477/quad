import { cn } from '@/lib/utils'

/**
 * Field — label, control, hint and error, wired together.
 *
 * The point of this component is that the wiring is not optional. Writing a
 * `<label>` and an `<input>` next to each other by hand works visually and then
 * quietly fails for anyone using a screen reader, because nothing connects them.
 * Here the caller passes the control as a render function receiving the ids it
 * must use, so `htmlFor`, `aria-describedby` and `aria-errormessage` cannot drift.
 *
 * The error is rendered in a `role="alert"` region so it is announced when it
 * appears rather than only when the field is next focused.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  required?: boolean
  className?: string
  children: (props: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': boolean | undefined
    required: boolean | undefined
  }) => React.ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required ? (
          <span className="ml-1 text-danger-600" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required: required || undefined,
      })}

      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}
