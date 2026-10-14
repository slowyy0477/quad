'use client'

import { Toaster as SonnerToaster } from 'sonner'

/**
 * Toaster — confirmation for a write that succeeded.
 *
 * The house rule, from UX.md §5: a toast may confirm something that has already
 * happened ("Post published", "Saved"). It may never carry an error, and it may never
 * be the only place a state change is visible. An error belongs next to the field that
 * caused it, because a toast disappears in four seconds and the user is still looking
 * at the form; and a message that scrolls away is a message the user will not find again
 * when they need it.
 *
 * Styled from the same tokens as everything else — the default look is a dark pill with
 * a drop shadow, which is precisely the interface this project is not.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      duration={4000}
      closeButton
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            'rounded-md border border-rule bg-paper-raised text-ink text-sm shadow-float',
          description: 'text-ink-muted',
          actionButton: 'bg-accent-600 text-white',
          cancelButton: 'bg-paper-sunken text-ink',
          closeButton: 'bg-paper-raised border border-hairline text-ink-muted',
        },
      }}
    />
  )
}
