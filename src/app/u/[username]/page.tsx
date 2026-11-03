import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { getPageRelationships } from '@/features/connections/graph-reads'
import { ProfileView } from '@/features/profiles/components/profile-view'
import { PortfolioSections } from '@/features/profiles/components/portfolio-sections'
import { getProfilePortfolio, parsePortfolioCursors } from '@/features/profiles/portfolio'
import { getMyProfile, getProfileByUsernameResult, toProfileSummary } from '@/features/profiles/queries'
import { InterestTags } from '@/features/skills/components/interest-tags'
import { SkillList } from '@/features/skills/components/skill-list'
import { listProfileInterests, listProfileSkills } from '@/features/skills/queries'
import { isDataConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { getUser } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { ReportDialog } from '@/features/moderation/components/report-dialog'

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
  if (!isDataConfigured()) return { title: 'Profile' }

  const { username } = await params
  const result = await getProfileByUsernameResult(username)
  if (result.state !== 'ok') return { title: result.state === 'missing' ? 'Profile not found' : 'Profile' }
  const { profile } = result

  return {
    title: `${profile.display_name} (@${profile.username})`,
    description: profile.headline ?? undefined,
  }
}

export default async function PublicProfilePage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!isLocalMode() && !isDataConfigured()) notFound()

  const { username } = await params
  const result = await getProfileByUsernameResult(username)
  if (result.state === 'missing') notFound()
  if (result.state === 'error') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="text-3xl">Profile</h1>
        <Alert tone="danger" title="The profile could not be loaded" className="mt-6">
          {result.message}
        </Alert>
      </div>
    )
  }
  const { profile } = result

  const user = await getUser()

  // `profile.id` is the profile row's id; `user.id` is the account's. They are the
  // same value in Postgres (profiles.id references auth.users) but not in the local
  // store, which mints its own `prf_…` ids. Comparing them directly would make the
  // demo user's own profile render as somebody else's, with Connect and Block offered
  // on it. Comparing profile ids is the check that holds in both modes.
  const me = user ? await getMyProfile() : null
  const isSelf = me?.state === 'ok' && me.profile.id === profile.id

  const query = await searchParams
  const [skills, interests, viewer, portfolioResult] = await Promise.all([
    listProfileSkills(profile.id),
    listProfileInterests(profile.id),
    user && !isSelf ? getPageRelationships([{
      id: profile.id, person: toProfileSummary(profile), created_at: profile.created_at, connectionId: null,
    }]) : Promise.resolve(null),
    getProfilePortfolio(profile.id, { cursors: parsePortfolioCursors(query) }),
  ])
  const relationship = viewer?.relationships[profile.id]
  const relationshipError = user && !isSelf
    ? me?.state === 'error' ? me.message
      : viewer?.error ?? (!relationship ? 'Relationship controls could not be loaded. Please try again.' : null)
    : null

  return (
    <div className="page-enter mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
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
            <div className="space-y-2">
              {relationshipError ? <Alert tone="warning">{relationshipError}</Alert> : <ConnectionControls
                profileId={profile.id}
                username={profile.username}
                displayName={profile.display_name}
                state={relationship?.state ?? 'none'}
                connectionId={relationship?.connectionId ?? null}
                isFollowing={relationship?.isFollowing ?? false}
                isBlockingThem={relationship?.isBlockingThem ?? false}
                signedIn={Boolean(user)}
                showBlock={Boolean(user)}
              />}
              {user ? (
                <ReportDialog kind="profile" targetId={profile.id} subject="this person"
                  trigger={<Button variant="ghost" size="sm" aria-label="Report this person">Report profile</Button>} />
              ) : null}
            </div>
          )
        }
      />
      <div className="mt-10">
        <PortfolioSections {...portfolioResult} basePath={`/u/${encodeURIComponent(profile.username)}`} />
      </div>
    </div>
  )
}
