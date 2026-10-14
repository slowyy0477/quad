import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { OnboardingForm } from '@/features/profiles/components/onboarding-form'
import { getMyProfile, listUniversities } from '@/features/profiles/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Set up your profile' }

/**
 * Onboarding.
 *
 * A generated handle (`u3f9c1a2b40de`) is what the sign-up trigger gives everyone,
 * because a trigger cannot ask a question. This is where that gets replaced.
 *
 * Someone who has already finished is sent to their profile rather than shown the
 * form again with their details in it -- the form's job is to set a username, and
 * re-submitting it would hit the 30-day change cooldown and fail confusingly. The
 * edit page is where changes belong.
 */
export default async function OnboardingPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-12">
        <h1 className="text-3xl">Set up your profile</h1>
        <Alert tone="warning" title="No database connected" className="mt-6">
          <p>
            A profile is a row in Postgres. Without Supabase credentials there is nowhere to save
            one. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/onboarding')

  const result = await getMyProfile()

  if (result.state === 'missing') {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-12">
        <h1 className="text-3xl">Set up your profile</h1>
        <Alert tone="danger" title="Your account has no profile row" className="mt-6">
          <p>
            You are signed in, but there is no profile in the database for this account. That happens
            when an account is created before the schema is applied — the trigger that creates the
            profile did not exist yet, and a trigger cannot act retroactively.
          </p>
          <p className="mt-2">
            Applying migration <code>0016_backfill_profiles.sql</code> creates the missing row. It is
            safe to run more than once. Nothing on this page can fix it from the browser.
          </p>
        </Alert>
      </div>
    )
  }

  if (result.state === 'ok' && result.profile.onboarding_completed) {
    redirect('/me')
  }

  const metadata = user.user_metadata ?? {}
  const metaString = (key: string) =>
    typeof metadata[key] === 'string' && metadata[key].trim() ? (metadata[key] as string) : null

  const defaultDisplayName =
    (result.state === 'ok' ? result.profile.display_name : null) ??
    metaString('display_name') ??
    metaString('full_name') ??
    metaString('name') ??
    user.email?.split('@')[0] ??
    ''

  // The generated handle is offered back as the default rather than a guess derived
  // from the email address: guessing produces something like "ali.hassan.2021",
  // which looks chosen and is not, and the person then has to notice and fix it.
  const suggestedUsername = result.state === 'ok' ? result.profile.username : ''

  const universities = await listUniversities()

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
      <p className="font-sans text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
        One step
      </p>
      <h1 className="mt-2 text-3xl">Set up your profile</h1>
      <p className="mt-2 max-w-prose text-ink-muted">
        Your account exists. This is the part that makes it yours — a handle people can find you by,
        and as much or as little else as you want to say.
      </p>

      <Surface className="mt-6 p-5 sm:p-6">
        <OnboardingForm
          universities={universities}
          defaultDisplayName={defaultDisplayName}
          suggestedUsername={suggestedUsername}
        />
      </Surface>
    </div>
  )
}
