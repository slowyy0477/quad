import Link from 'next/link'
import { Hammer } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The page shown where a feature will go.
 *
 * Keep the product's unavailable state clear without publishing the internal
 * implementation ledger or configuration notes.
 */
export function PlannedFeature({
  title,
  children,
}: {
  title: string
  /** Retained for existing callers; internal ledger details are not rendered. */
  featureName: string
  children?: React.ReactNode
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <Hammer className="size-6 text-ink-faint" aria-hidden="true" />
      <h1 className="mt-4 text-3xl">{title}</h1>

      <p className="mt-4 text-ink-muted">
        This tool is not available in this preview yet.
      </p>

      {children ? <div className="mt-6 text-sm text-ink-muted">{children}</div> : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="secondary">
          <Link href="/help">Get help</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/feed">Back to the feed</Link>
        </Button>
      </div>
    </div>
  )
}
