import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { ProfileEditForm } from '@/features/profiles/components/profile-edit-form'
import { getMyProfile, listUniversities } from '@/features/profiles/queries'
import { isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Edit your profile' }

export default async function EditProfilePage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-3xl">Edit your profile</h1>
        <Alert tone="warning" title="No database connected" className="mt-6">
          <p>
            Nothing typed here could be saved, so the form is not shown.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const result = await getMyProfile()

  if (result.state === 'signed-out') redirect('/login?next=/me/edit')
  if (result.state === 'missing') redirect('/me')

  // An account that has not been through onboarding has no chosen username, and this
  // form cannot set one. Sending them to the place that can is more useful than
  // showing a form missing the field they need.
  if (!result.profile.onboarding_completed) redirect('/onboarding')

  const universities = await listUniversities()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl">Edit your profile</h1>
        <Button asChild variant="ghost" size="sm">
          <Link href="/me">Back to profile</Link>
        </Button>
      </div>

      <Surface className="p-5 sm:p-6">
        <ProfileEditForm profile={result.profile} universities={universities} />
      </Surface>

      <p className="mt-5 text-xs text-ink-faint">
        Avatar uploads are not built — storage buckets and file validation are not written yet, so no
        upload control is shown. A Google-signed-in account keeps whatever picture Google supplied.
      </p>
    </div>
  )
}
