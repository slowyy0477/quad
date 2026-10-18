'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * The moderation area's error boundary.
 *
 * `error.message` is not rendered, for the same reason as the root boundary: in
 * development it is the real exception, and a component that shows it is one
 * deployment away from showing a Postgres error to a moderator. The digest is
 * enough to find the entry in the server log.
 *
 * The one thing this boundary says that the root one does not: nothing has been
 * lost. A moderator who has just filled in a reason and lost the page needs to
 * know whether a decision was recorded, and the answer is knowable — the audit log
 * is append-only, so if the action landed it is there.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[admin]', error.digest, error)
  }, [error])

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-ink">The moderation area could not be loaded</h1>

      <Alert tone="danger" title="Something went wrong">
        The error has been logged with a reference. No decision was recorded for a form you had not
        finished submitting — if you had finished, it is in the audit log, because a decision is
        written in one transaction and appears in full or not at all.
      </Alert>

      {error.digest ? (
        <p className="font-mono text-xs text-ink-faint">Reference: {error.digest}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="secondary">
          <Link href="/admin/audit">Check the audit log</Link>
        </Button>
      </div>
    </div>
  )
}
