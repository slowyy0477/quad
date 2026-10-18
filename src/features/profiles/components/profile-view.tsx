import Link from 'next/link'
import { CalendarDays, Github, GraduationCap, Link2, MapPin } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import type { FullProfile } from '@/features/profiles/queries'

/**
 * A profile, as rendered on both /me and /u/[username].
 *
 * The numbers are real. Every one of them is a column maintained by a database
 * trigger on the event it counts -- `posts_sync_profile_count` on insert and
 * delete, `follows_sync_counts`, `connections_sync_counts` -- so they cannot drift
 * from the rows they describe and they are not computed in the page. A count that
 * is zero is shown as zero.
 *
 * The sections this file does not own arrive as slots: the connection controls,
 * the skills and the interests are rendered by the features that own those tables
 * and passed in by the page that composes them. That keeps this component free of
 * cross-feature imports, and it means a change to what a skill row looks like is a
 * change in one place rather than two.
 *
 * Order is deliberate and follows the interface contract: capabilities before
 * biography. Name, where they study, what they can do, then what they say about
 * themselves.
 */

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-display text-lg text-ink tabular-nums">{value}</p>
      <p className="text-2xs tracking-wide text-ink-faint uppercase">{label}</p>
    </div>
  )
}

function MetaLine({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-ink-muted">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}

const VISIBILITY_NOTE: Record<string, string> = {
  public: 'Anyone can see this profile, including people who are not signed in.',
  university: 'Only people at your university can see this profile.',
  connections: 'Only people you are connected to can see this profile.',
  private: 'Only you can see this profile.',
}

export function ProfileView({
  profile,
  isSelf = false,
  actions,
  skills,
  interests,
}: {
  profile: FullProfile
  isSelf?: boolean
  /** Connection and follow controls, built by the page that knows the reader's standing. */
  actions?: React.ReactNode
  /** The skills section, built by features/skills. */
  skills?: React.ReactNode
  /** The interests section, built by features/skills. */
  interests?: React.ReactNode
}) {
  const joined = new Date(profile.created_at).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  const study = [profile.degree, profile.semester ? `semester ${profile.semester}` : null]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        <Avatar name={profile.display_name} src={profile.avatar_url} size="xl" />

        <div className="min-w-0 flex-1">
          <h1 className="text-3xl break-words">{profile.display_name}</h1>
          <p className="mt-0.5 font-mono text-sm text-ink-muted">@{profile.username}</p>
          {profile.headline ? (
            <p className="mt-2 max-w-prose text-ink">{profile.headline}</p>
          ) : null}

          {isSelf ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone={profile.visibility === 'public' ? 'neutral' : 'accent'}>
                {profile.visibility === 'public' ? 'Public profile' : `Visible to: ${profile.visibility}`}
              </Badge>
              {!profile.onboarding_completed ? (
                <Badge tone="highlight">Setup unfinished</Badge>
              ) : null}
            </div>
          ) : null}

          {actions ? <div className="mt-4">{actions}</div> : null}
        </div>
      </header>

      <div className="flex flex-wrap gap-x-8 gap-y-4 border-y border-hairline py-4">
        <Stat label="Posts" value={profile.post_count} />
        <Stat label="Projects" value={profile.project_count} />
        <Stat label="Followers" value={profile.follower_count} />
        <Stat label="Following" value={profile.following_count} />
        <Stat label="Connections" value={profile.connection_count} />
      </div>

      <Section title="Details">
        <ul className="space-y-2">
          {profile.university ? (
            <MetaLine icon={GraduationCap}>
              {profile.university.name}
              {study ? <span className="text-ink-faint"> — {study}</span> : null}
              {profile.graduation_year ? (
                <span className="text-ink-faint"> · graduating {profile.graduation_year}</span>
              ) : null}
            </MetaLine>
          ) : study || profile.graduation_year ? (
            <MetaLine icon={GraduationCap}>
              {study || `Graduating ${profile.graduation_year}`}
            </MetaLine>
          ) : null}

          {profile.location ? <MetaLine icon={MapPin}>{profile.location}</MetaLine> : null}

          {profile.website ? (
            <MetaLine icon={Link2}>
              {/* rel="ugc nofollow" because this URL is user-supplied and this page
                  is not an endorsement of wherever it points. */}
              <a
                href={profile.website}
                rel="ugc nofollow noopener noreferrer"
                target="_blank"
                className="break-all text-accent-700 underline underline-offset-2"
              >
                {profile.website.replace(/^https?:\/\//, '')}
              </a>
            </MetaLine>
          ) : null}

          {profile.github_username ? (
            <MetaLine icon={Github}>
              <a
                href={`https://github.com/${profile.github_username}`}
                rel="ugc nofollow noopener noreferrer"
                target="_blank"
                className="text-accent-700 underline underline-offset-2"
              >
                {profile.github_username}
              </a>
            </MetaLine>
          ) : null}

          <MetaLine icon={CalendarDays}>Joined {joined}</MetaLine>
        </ul>
      </Section>

      {skills ? <Section title="Skills">{skills}</Section> : null}

      {interests ? <Section title="Interests">{interests}</Section> : null}

      {profile.bio ? (
        <Section title="About">
          <p className="max-w-prose whitespace-pre-line text-ink">{profile.bio}</p>
        </Section>
      ) : null}

      {isSelf ? (
        <p className="border-t border-hairline pt-4 text-xs text-ink-faint">
          {VISIBILITY_NOTE[profile.visibility] ?? ''} Change it from{' '}
          <Link href="/me/edit" className="text-accent-700 underline underline-offset-2">
            edit profile
          </Link>
          .
        </p>
      ) : null}
    </div>
  )
}
