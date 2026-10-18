'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * The bug form's error boundary.
 *
 * The reader arrived here to help, so a failure has to be repaired rather than
 * apologised for: the button offers the form again, and the second link is the
 * only honest fallback in a product with no support address — the maintainer's own
 * profile, which is already public.
 *
 * `error.message` is not rendered. See src/app/error.tsx.
 */
export default function ReportABugError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[report-a-bug]', error.digest, error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-2xl text-ink">The form could not be loaded</h1>

      <Alert tone="danger" title="Something went wrong" className="mt-6">
        The error has been logged with a reference. Nothing you had typed was sent, so if you get
        the form back you will need to write it again — sorry about that.
      </Alert>

      {error.digest ? (
        <p className="mt-4 font-mono text-xs text-ink-faint">Reference: {error.digest}</p>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-2">
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
