import Link from 'next/link'
import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import {
  FEATURES,
  STATUS_LABELS,
  featuresByArea,
  statusCounts,
  type FeatureStatus,
} from '@/lib/build-status'

export const metadata: Metadata = {
  title: 'Build status',
  description: 'Which parts of Quad work, which are database-only, and which are not built yet.',
}

const tones: Record<FeatureStatus, 'success' | 'highlight' | 'accent' | 'neutral'> = {
  working: 'success',
  partial: 'highlight',
  'schema-only': 'accent',
  planned: 'neutral',
}

/**
 * Build status.
 *
 * A public page rather than a note in a README, because the people most likely to
 * be misled by a half-built interface are the ones using it, not the ones reading
 * the repository. Anything described here as "database only" has no interface, and
 * no page in the app implies otherwise.
 */
export default function StatusPage() {
  const counts = statusCounts()

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Build status</h1>
      <p className="mt-3 max-w-2xl text-ink-muted">
        Quad is under construction. This page lists every feature and says plainly whether it works,
        whether only its database layer exists, or whether it has not been built. It is updated as
        part of the work rather than afterwards.
      </p>

      <dl className="mt-8 grid grid-cols-2 gap-4 border-y border-rule py-5 sm:grid-cols-4">
        {(Object.keys(counts) as FeatureStatus[]).map((status) => (
          <div key={status}>
            <dt className="text-xs text-ink-muted">{STATUS_LABELS[status]}</dt>
            <dd className="mt-1 font-display text-2xl text-ink tabular">{counts[status]}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 text-xs text-ink-faint">
        {FEATURES.length} tracked features. Counts are of features listed on this page, not of
        anything measured about usage — nobody is using Quad yet.
      </p>

      <div className="mt-10 space-y-10">
        {featuresByArea().map(([area, features]) => (
          <section key={area}>
            <h2 className="border-b border-rule pb-2 text-xl">{area}</h2>
            <ul className="divide-y divide-hairline">
              {features.map((feature) => (
                <li key={feature.name} className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
                  <div className="sm:w-40 sm:shrink-0">
                    <Badge tone={tones[feature.status]}>{STATUS_LABELS[feature.status]}</Badge>
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-sans text-base font-medium text-ink">{feature.name}</h3>
                    <p className="mt-1 text-sm text-ink-muted">{feature.note}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="mt-12 border-t border-rule pt-6">
        <h2 className="text-xl">Running this yourself</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Anything above that needs a database needs Supabase credentials first.{' '}
          <Link href="/setup" className="text-accent-700 underline underline-offset-2">
            The setup page
          </Link>{' '}
          shows what this deployment is missing.
        </p>
      </section>
    </div>
  )
}
