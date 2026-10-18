'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The search route's error boundary.
 *
 * `error.digest` and nothing else. `error.message` can carry a query, a path or row
 * data out of the server render, and the digest is enough to find the real entry in
 * the server log.
 */
export default function SearchError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[search]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl">That search could not be run</h1>
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
