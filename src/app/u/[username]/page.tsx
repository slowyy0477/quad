import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { getViewerConnection } from '@/features/connections/queries'
import { ProfileView } from '@/features/profiles/components/profile-view'
import { getMyProfile, getProfileByUsername } from '@/features/profiles/queries'
import { InterestTags } from '@/features/skills/components/interest-tags'
import { SkillList } from '@/features/skills/components/skill-list'
import { listProfileInterests, listProfileSkills } from '@/features/skills/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { getUser } from '@/lib/supabase/server'

/**
 * A public profile.
 *
 * `notFound()` is returned both for a handle nobody has and for a profile the reader
 * is not allowed to see. That is not an oversight: RLS returns zero rows in both
 * cases, and telling the two apart would confirm the existence of an account to
 * exactly the person who has been refused access to it.
 *
 * The same zero-rows rule is what makes a block work here without a single line of
 * code about blocking on this page: once either party has blocked the other,
 * `app.can_view_profile` refuses the row and this route 404s for the blocked
 * reader. The permission suite asserts exactly that.
 *
 * The skills and interests sections are built by the feature that owns those
 * tables and handed to the view as slots, which is why this page imports from three
 * domains where the view imports from none.
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
  if (!isLocalMode() && !isSupabaseConfigured()) notFound()

  const { username } = await params
  const profile = await getProfileByUsername(username)
  if (!profile) notFound()

  const user = await getUser()

  // `profile.id` is the profile row's id; `user.id` is the account's. They are the
  // same value in Postgres (profiles.id references auth.users) but not in the local
  // store, which mints its own `prf_…` ids. Comparing them directly would make the
  // demo user's own profile render as somebody else's, with Connect and Block offered
  // on it. Comparing profile ids is the check that holds in both modes.
  const me = user ? await getMyProfile() : null
  const isSelf = me?.state === 'ok' && me.profile.id === profile.id

  const [skills, interests, viewer] = await Promise.all([
    listProfileSkills(profile.id),
    listProfileInterests(profile.id),
    user && !isSelf ? getViewerConnection(profile.id) : Promise.resolve(null),
  ])

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <ProfileView
        profile={profile}
        isSelf={isSelf}
        skills={
          skills.length > 0 ? (
            <SkillList skills={skills} isSelf={isSelf} />
          ) : isSelf ? (
            <div className="border-t border-hairline pt-4">
              <p className="text-sm text-ink-muted">
                No skills yet, so there is nothing for anyone to find you by.
              </p>
              <p className="mt-2">
                <Link href="/me/skills" className="text-accent-700 underline underline-offset-2">
                  Add your first skill
                </Link>
              </p>
            </div>
          ) : undefined
        }
        interests={
          interests.length > 0 ? (
            <InterestTags interests={interests} isSelf={isSelf} />
          ) : isSelf ? (
            <div>
              <p className="text-sm text-ink-muted">No interests tagged yet.</p>
              <p className="mt-2">
                <Link href="/me/skills" className="text-accent-700 underline underline-offset-2">
                  Tag a few topics
                </Link>
              </p>
            </div>
          ) : undefined
        }
        actions={
          isSelf ? undefined : (
            <ConnectionControls
              profileId={profile.id}
              username={profile.username}
              displayName={profile.display_name}
              state={viewer?.state ?? 'none'}
              connectionId={viewer?.connectionId ?? null}
              isFollowing={viewer?.isFollowing ?? false}
              isBlockingThem={viewer?.isBlockingThem ?? false}
              signedIn={Boolean(user)}
              showBlock={Boolean(user)}
            />
          )
        }
      />
    </div>
  )
}
