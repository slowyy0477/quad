'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The last-resort error boundary.
 *
 * `error.message` is not rendered. In production Next replaces it with a generic
 * string, but in development it is the real exception, and a component that shows
 * it in development is one deployment away from showing a database error — or a
 * connection string — to a user. The digest is enough to find the entry in the
 * server log, which is where the detail belongs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[unhandled]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl">Something went wrong</h1>
      <p className="mt-3 text-ink-muted">
        The error has been logged. Trying again often works; if it does not, the problem is on our
        side rather than yours.
      </p>
      {error.digest ? (
        <p className="mt-4 font-mono text-xs text-ink-faint">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-8 flex justify-center">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
