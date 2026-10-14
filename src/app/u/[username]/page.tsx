import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ProfileView } from '@/features/profiles/components/profile-view'
import { getProfileByUsername } from '@/features/profiles/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

/**
 * A public profile.
 *
 * `notFound()` is returned both for a handle nobody has and for a profile the reader
 * is not allowed to see. That is not an oversight: RLS returns zero rows in both
 * cases, and telling the two apart would confirm the existence of an account to
 * exactly the person who has been refused access to it.
 */
type Params = { username: string }

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>
}): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Profile' }

  const { username } = await params
  const profile = await getProfileByUsername(username)
  if (!profile) return { title: 'Profile not found' }

  return {
    title: `${profile.display_name} (@${profile.username})`,
    description: profile.headline ?? undefined,
  }
}

export default async function PublicProfilePage({ params }: { params: Promise<Params> }) {
  if (!isSupabaseConfigured()) notFound()

  const { username } = await params
  const profile = await getProfileByUsername(username)
  if (!profile) notFound()

  const user = await getUser()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <ProfileView profile={profile} isSelf={user?.id === profile.id} />
    </div>
  )
}
