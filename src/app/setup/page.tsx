import type { Metadata } from 'next'
import { Check, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { describeEnvProblems, hasServiceRoleKey, isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Setup' }

/**
 * Setup / configuration status.
 *
 * The page that exists so no other page has to lie. It reports which environment
 * variables this process can see and what to do about the missing ones.
 *
 * It reports *presence*, never values. A configuration page is exactly the kind of
 * thing someone screenshots into a chat window when asking for help, and a page
 * that prints the first few characters of a key has leaked a key. Even the anon
 * key, which is public by design, is reported only as present or absent, because
 * the habit is what matters: the next variable added to this list might not be
 * public.
 */
function Row({ present, name, description }: { present: boolean; name: string; description: string }) {
  return (
    <li className="flex gap-3 py-3">
      {present ? (
        <Check className="mt-0.5 size-4 shrink-0 text-success-600" aria-hidden="true" />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-danger-600" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="font-mono text-xs text-ink">{name}</p>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      </div>
      <span className="ml-auto shrink-0 self-start text-xs text-ink-faint">
        {present ? 'set' : 'missing'}
      </span>
    </li>
  )
}

export default function SetupPage() {
  const configured = isSupabaseConfigured()
  const problems = describeEnvProblems()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Setup</h1>
      <p className="mt-3 text-ink-muted">
        Quad needs a Supabase project for authentication, the database and file storage. This page
        reports what this running process can see.
      </p>

      {configured ? (
        <Alert tone="success" title="Supabase is configured" className="mt-6">
          <p>
            Accounts, the feed and everything else that reads the database will work, provided the
            migrations in <code className="font-mono text-xs">supabase/migrations</code> have been
            applied to that project.
          </p>
        </Alert>
      ) : (
        <Alert tone="warning" title="Supabase is not configured" className="mt-6">
          <p>
            The application is running, but every feature that needs data is switched off and says
            so. Nothing here is faked to fill the gap.
          </p>
        </Alert>
      )}

      <Surface className="mt-6 px-4">
        <h2 className="sr-only">Environment variables</h2>
        <ul className="divide-y divide-hairline">
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)}
            name="NEXT_PUBLIC_SUPABASE_URL"
            description="Your project URL, e.g. https://abcdefgh.supabase.co — no trailing slash."
          />
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)}
            name="NEXT_PUBLIC_SUPABASE_ANON_KEY"
            description="The public anon key. Safe in the browser: what it can do is decided by row-level security."
          />
          <Row
            present={hasServiceRoleKey()}
            name="SUPABASE_SERVICE_ROLE_KEY"
            description="Secret. Needed only by admin scripts, never sent to the browser. Optional for browsing the site."
          />
          <Row
            present={Boolean(process.env.NEXT_PUBLIC_SITE_URL)}
            name="NEXT_PUBLIC_SITE_URL"
            description="This deployment's own origin. Required in production so OAuth redirects come back here; defaults to localhost in development."
          />
        </ul>
      </Surface>

      {problems.length > 0 ? (
        <Alert tone="danger" title="Problems found" className="mt-4">
          <ul className="list-disc space-y-1 pl-4">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <section className="mt-10">
        <h2 className="text-xl">How to configure it</h2>
        <ol className="mt-4 space-y-4 text-sm text-ink-muted">
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">1. Create a Supabase project.</span> Free tier is
            enough. Note the project URL and the anon key from <em>Project settings → API</em>.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">2. Copy the example environment file.</span>{' '}
            <code className="font-mono text-xs">cp .env.example .env.local</code>, then fill in the
            values. <code className="font-mono text-xs">.env.local</code> is git-ignored.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">3. Apply the migrations.</span>{' '}
            <code className="font-mono text-xs">npx supabase link</code> then{' '}
            <code className="font-mono text-xs">npm run db:push</code>. This creates all 52 tables
            with their policies, functions and triggers.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">4. Restart the dev server.</span> Environment
            variables are read at startup, so a running server will not pick up a new{' '}
            <code className="font-mono text-xs">.env.local</code>.
          </li>
          <li className="border-l-2 border-hairline pl-4">
            <span className="font-medium text-ink">5. Optional: enable Google sign-in.</span>{' '}
            <em>Authentication → Providers → Google</em> in the Supabase dashboard, with{' '}
            <code className="font-mono text-xs">/auth/callback</code> on this origin as the redirect
            URL.
          </li>
        </ol>
      </section>
    </div>
  )
}
