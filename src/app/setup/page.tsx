import type { Metadata } from 'next'
import Link from 'next/link'
import { Check, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { describeEnvProblems, hasServiceRoleKey, isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'

export const metadata: Metadata = { title: 'Setup' }

/**
 * Setup / configuration status.
 *
 * Reports the selected provider and configuration presence, not service health
 * or release readiness. Public settings are captured when Next.js builds them.
 *
 * It reports *presence*, never values. A configuration page is exactly the kind of
 * thing someone screenshots into a chat window when asking for help, and a page
 * that prints the first few characters of a key has leaked a key. Even the anon
 * key, which is public by design, is reported only as present or absent, because
 * the habit is what matters: the next variable added to this list might not be
 * public.
 */
function Row({
  present,
  name,
  description,
  optional = false,
}: {
  present: boolean
  name: string
  description: string
  optional?: boolean
}) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
      {present ? (
        <Check className="mt-0.5 size-4 shrink-0 text-success-600" aria-hidden="true" />
      ) : (
        <X
          className={`mt-0.5 size-4 shrink-0 ${optional ? 'text-ink-faint' : 'text-danger-600'}`}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <p className="break-all font-mono text-xs text-ink">{name}</p>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      </div>
      <span className="col-start-2 row-start-2 text-xs text-ink-faint sm:col-start-3 sm:row-start-1">
        {present ? 'set' : optional ? 'not set (optional)' : 'missing'}
      </span>
    </li>
  )
}

export default function SetupPage() {
  const local = isLocalMode()
  const configured = isSupabaseConfigured()
  const problems = describeEnvProblems()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Setup</h1>
      <p className="mt-3 text-ink-muted">
        Bulla can use a private local data store or a hosted Supabase backend. This page shows the
        selected mode and configuration presence, never credential values. It is not a service
        health check.
      </p>

      <section className="mt-8" aria-labelledby="selected-mode-heading">
        <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">Selected data mode</p>
        <h2 id="selected-mode-heading" className="mt-2 text-xl">
          {local ? 'Local mode (private preview)' : 'Hosted mode (Supabase)'}
        </h2>
        {local ? (
          <Alert tone="warning" role="status" title="Local accounts and data" className="mt-4">
            <p>
              Local accounts and saved content work without Supabase keys. Data stays on the
              computer running Bulla. Keep this mode private and loopback-bound; the local store
              is not a public backend.
            </p>
            <p>Supabase settings below do not switch this preview to hosted mode.</p>
          </Alert>
        ) : (
          <Alert
            tone={configured ? 'info' : 'warning'}
            role="status"
            title={configured ? 'Hosted configuration present' : 'Hosted configuration needs attention'}
            className="mt-4"
          >
            {configured ? (
              <p>
                Browser configuration is present and passed format checks. No connection or
                migration check has been run here.
              </p>
            ) : (
              <p>
                Hosted browser configuration is missing or invalid. Data-backed screens remain
                unavailable until the required configuration passes validation.
              </p>
            )}
          </Alert>
        )}
      </section>

      <Surface as="section" aria-label="Hosted environment variables" className="mt-6 px-4 pt-4">
        <SectionHeading
          title="Hosted environment variables"
          description="Presence only, not connectivity. These settings are not required for local mode."
        />
        <ul className="divide-y divide-hairline">
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)}
            name="NEXT_PUBLIC_SUPABASE_URL"
            description="Required browser configuration for hosted mode: the Supabase project URL, with no trailing slash."
          />
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)}
            name="NEXT_PUBLIC_SUPABASE_ANON_KEY"
            description="Required browser configuration for hosted mode: the public anon key. Database grants and row-level security still need verification."
          />
          <Row
            present={hasServiceRoleKey()}
            name="SUPABASE_SERVICE_ROLE_KEY"
            optional
            description="Optional, server-only administrative credential; not required for browser configuration. It bypasses row-level security, so never expose it to the browser."
          />
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SITE_URL)}
            name="NEXT_PUBLIC_SITE_URL"
            optional
            description="Deployment origin for links and auth redirects. Set the actual HTTPS origin before hosted auth testing; an automatic fallback is not a verified callback."
          />
        </ul>
      </Surface>

      {problems.length > 0 ? (
        <Alert
          tone={local ? 'info' : 'danger'}
          role="status"
          title={local ? 'Hosted configuration notes (not required for local mode)' : 'Hosted configuration problems'}
          className="mt-4"
        >
          <ul className="list-disc space-y-1 pl-4">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <section className="mt-8 border-t border-rule pt-6">
        <SectionHeading title="What still needs evidence" />
        <p className="text-sm text-ink-muted">
          Email delivery, OAuth sign-in, hosted Realtime and cloud file storage are not established
          by local mode. Hosted configuration presence does not verify a successful connection,
          applied migrations, authentication or any of those integrations.
        </p>
        <p className="mt-3 text-sm text-ink-muted">
          Public launch requires recorded staging, security, backup/restore and measured load-test
          evidence. Production readiness is unverified; 50,000-user capacity has not been verified.
        </p>
        <Link href="/status" className="mt-3 inline-flex min-h-11 items-center text-sm text-accent-700 underline underline-offset-2">
          Review build status and remaining work
        </Link>
      </section>

      <section className="mt-8" aria-labelledby="hosted-setup-heading">
        <h2 id="hosted-setup-heading" className="text-xl">How to configure hosted mode safely</h2>
        <ol className="mt-4 space-y-4 text-sm text-ink-muted">
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">1. Choose the intended provider.</span>{' '}
            <code className="break-all font-mono text-xs">NEXT_PUBLIC_DATA_MODE=local</code> keeps a
            private preview without cloud keys. Use{' '}
            <code className="break-all font-mono text-xs">NEXT_PUBLIC_DATA_MODE=supabase</code> for
            the hosted adapter and follow the remaining steps.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">2. Use an approved staging project.</span>{' '}
            Confirm its region, pricing and quotas against the intended workload. No plan or free
            tier is assumed sufficient.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">3. Preserve existing environment settings.</span>{' '}
            If .env.local already exists, preserve its values and edit only the intended settings.
            If it does not exist, use .env.example as a starting template. Keep secrets out of
            version control and never give a service-role key a NEXT_PUBLIC_ prefix.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">4. Review migration history and recovery.</span>{' '}
            Compare the ordered files in <code className="font-mono text-xs">supabase/migrations</code>{' '}
            with the target project&apos;s migration history. Before applying changes, confirm the
            target project, backups and a recovery plan in staging. This page does not provision
            services or apply migrations.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">5. Restart or rebuild after changes.</span>{' '}
            Restart the development server after editing configuration. NEXT_PUBLIC_* values are
            embedded at build time, so rebuild before deploying changes to public settings.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">6. Verify integrations separately.</span>{' '}
            Complete and test hosted account journeys, email delivery, OAuth redirects, database
            policies, authorized Realtime and storage in staging. A key being present cannot
            confirm these services work.
          </li>
        </ol>
      </section>
    </div>
  )
}
