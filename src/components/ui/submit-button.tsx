'use client'

import { useFormStatus } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'

/**
 * A submit button that knows whether its own form is in flight.
 *
 * `useFormStatus` reads the state of the nearest enclosing form, which is why this
 * has to be a separate component from the form itself -- the hook returns
 * `pending: false` when called in the component that renders the `<form>`.
 *
 * Disabled while pending, so a double-click cannot submit twice. `aria-disabled`
 * as well as `disabled`, because a disabled button drops out of the tab order and
 * a keyboard user's focus lands somewhere unexpected mid-submit.
 */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending} aria-disabled={pending} {...props}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden="true" />
          {pendingLabel ?? 'Working…'}
        </>
      ) : (
        children
      )}
    </Button>
  )
}
