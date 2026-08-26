import Link from 'next/link'
import { Hammer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FEATURES, STATUS_LABELS } from '@/lib/build-status'

/**
 * The page shown where a feature will go.
 *
 * The alternative was to leave these routes as 404s, or to leave the links out
 * entirely. Both are worse: a 404 reads as a broken site, and hiding the links
 * hides the shape of what is being built. What is not acceptable is a page that
 * looks finished and is not, so this one is unmistakably a placeholder and it
 * reads its own status from the same list the build-status page uses — there is no
 * way for the two to disagree.
 */
export function PlannedFeature({
  title,
  featureName,
  children,
}: {
  title: string
  /** Must match a `name` in lib/build-status.ts. */
  featureName: string
  children?: React.ReactNode
}) {
  const feature = FEATURES.find((entry) => entry.name === featureName)

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <Hammer className="size-6 text-ink-faint" aria-hidden="true" />
      <h1 className="mt-4 text-3xl">{title}</h1>

      <p className="mt-4 text-ink-muted">
        This part of Quad is not built yet, and rather than show you a mock-up of it, this page says
        so.
      </p>

      {feature ? (
        <div className="mt-6 border-l-2 border-highlight-400 pl-4">
          <p className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
            Current status — {STATUS_LABELS[feature.status]}
          </p>
          <p className="mt-1.5 text-sm text-ink-muted">{feature.note}</p>
        </div>
      ) : null}

      {children ? <div className="mt-6 text-sm text-ink-muted">{children}</div> : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="secondary">
          <Link href="/status">See what does work</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/feed">Back to the feed</Link>
        </Button>
      </div>
    </div>
  )
}
