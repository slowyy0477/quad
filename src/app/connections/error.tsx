'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'

/**
 * The connections area's error boundary. `error.message` is not rendered, for the
 * reason given in the root boundary: in development it is the real exception, and
 * a component that shows it is one deployment away from showing a reader a
 * database error. The digest is enough to find the log entry.
 */
export default function ConnectionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl">Your connections could not be loaded</h1>
      <p className="mt-3 text-ink-muted">
        The database did not answer. Nothing has been changed by this page.
      </p>
      {error.digest ? (
        <p className="mt-4 font-mono text-xs text-ink-faint">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="secondary">
          <Link href="/feed">Back to the feed</Link>
        </Button>
      </div>
    </div>
  )
}
