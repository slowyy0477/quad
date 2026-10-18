'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Route-level boundary for the opportunity board.
 *
 * `error.message` is never rendered, for the reason in `src/app/error.tsx`: in
 * development it is the real exception, and a database message on its way to a user names
 * tables and constraints. The digest is what ties this to the server log.
 */
export default function OpportunitiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[opportunities]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl">Opportunities could not be shown</h1>
      <p className="mt-3 text-sm text-ink-muted">
        The board failed to load. Trying again often works; nothing was changed.
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
