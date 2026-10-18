'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'

/**
 * The universities segment's error boundary.
 *
 * Rendered instead of the page when a render throws — a query that fails in a way
 * the page cannot turn into a sentence, for instance. The digest is shown and the
 * message is not, for the reason given in the root boundary: in development
 * `error.message` is the real exception, and a component that displays it is one
 * deployment away from showing a database error to a reader.
 */
export default function UniversitiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl">The directory could not be loaded</h1>
      <p className="mt-3 text-ink-muted">
        This is our fault rather than yours. Trying again often works.
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
