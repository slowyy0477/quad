'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Route-level boundary for the idea vault.
 *
 * `error.message` is not rendered — in development it is the real exception, and a
 * Postgres message names tables and constraints. The digest is the reference to the
 * server log and the only part that is safe to show.
 */
export default function IdeasError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[ideas]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl">Ideas could not be shown</h1>
      <p className="mt-3 text-sm text-ink-muted">
        The vault failed to load. Trying again often works; nothing was changed.
      </p>
      {error.digest ? <p className="mt-4 font-mono text-xs text-ink-faint">Reference: {error.digest}</p> : null}
      <div className="mt-6 flex justify-center">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
