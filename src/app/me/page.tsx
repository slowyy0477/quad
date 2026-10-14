import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ProfileView } from '@/features/profiles/components/profile-view'
import { getMyProfile } from '@/features/profiles/queries'
import { isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Your profile' }

/**
 * Your own profile.
 *
 * This renders your row as *you* see it, which is not necessarily how anyone else
 * does -- the visibility setting is enforced by RLS on reads by other people, and it
 * never hides your own row from you. That difference is stated on the page, because
 * a private profile that looks complete when you view it invites the assumption that
 * everyone else sees the same thing.
 */
export default async function MyProfilePage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-3xl">Your profile</h1>
        <Alert tone="warning" title="No database connected" className="mt-6">
          <p>
            A profile is read from Postgres. Without Supabase credentials there is nothing to read.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const result = await getMyProfile()

  if (result.state === 'signed-out') redirect('/login?next=/me')

  if (result.state === 'missing') {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-3xl">Your profile</h1>
        <Alert tone="danger" title="Your account has no profile row" className="mt-6">
          <p>
            You are signed in, but the database has no profile for this account. This happens when an
            account is created before the schema is applied: the trigger that creates profiles did not
            exist yet, and triggers do not act on rows that already existed.
          </p>
          <p className="mt-2">
            Applying <code>supabase/migrations/0016_backfill_profiles.sql</code> creates the missing
            row from your account details. It is safe to run more than once.
          </p>
        </Alert>
      </div>
    )
  }

  const { profile } = result

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="font-sans text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
          Your profile
        </p>
        <div className="flex gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link href="/me/edit">Edit profile</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/u/${profile.username}`}>View as public</Link>
          </Button>
        </div>
      </div>

      {!profile.onboarding_completed ? (
        <Alert tone="info" title="You have not finished setting up" className="mb-6">
          <p>
            Your handle is still the one generated when your account was created. Setting a real one
            takes a minute.
          </p>
          <p className="mt-3">
            <Button asChild variant="secondary" size="sm">
              <Link href="/onboarding">Finish setup</Link>
            </Button>
          </p>
        </Alert>
      ) : null}

      <ProfileView profile={profile} isSelf />
    </div>
  )
}
