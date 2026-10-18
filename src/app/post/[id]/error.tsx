'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The post route's error boundary.
 *
 * `error.digest` only: in a Server Component `error.message` can contain a query,
 * a path or row data, and the digest is enough to find the log entry.
 */
export default function PostError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[post]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl">This post could not be loaded</h1>
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
