import Link from 'next/link'
import { CalendarDays, Github, GraduationCap, Link2, MapPin } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type { FullProfile } from '@/features/profiles/queries'

/**
 * A profile, as rendered on both /me and /u/[username].
 *
 * Relationship counts come from the caller-authorized graph reader, with the
 * same eligible peers as the linked lists. Foreign connections are private.
 * A failed/unavailable count is not displayed as zero.
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

function Stat({ label, value, href }: { label: string; value: number | null; href?: string }) {
  const content = (
    <>
      <span className="block font-display text-lg text-ink tabular-nums">
        {value === null ? <><span aria-hidden="true">—</span><span className="sr-only">Count unavailable</span></> : value}
      </span>
      {' '}
      <span className="block text-2xs tracking-wide text-ink-faint uppercase">{label}</span>
    </>
  )
  return href ? (
    <Link href={href} prefetch={false}
      className="min-h-11 rounded-md px-2 py-1 underline-offset-4 transition-colors hover:bg-paper-sunken hover:underline">
      {content}
    </Link>
  ) : <div className="px-2 py-1">{content}</div>
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
  const showGraph = isSelf || profile.visibility === 'public'
  const graphBase = isSelf ? '/connections' : `/u/${encodeURIComponent(profile.username)}`

  return (
    <div className="space-y-8">
      <header className="profile-identity p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
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
        </div>

      <div className="mt-6 -mx-2 flex flex-wrap gap-x-5 gap-y-3 border-t border-hairline pt-5">
        <Stat label="Posts" value={profile.post_count} />
        <Stat label="Projects" value={profile.project_count} />
        {showGraph ? <>
          <Stat label="Followers" value={profile.follower_count} href={`${graphBase}/followers`} />
          <Stat label="Following" value={profile.following_count} href={`${graphBase}/following`} />
        </> : null}
        {isSelf ? <Stat label="Connections" value={profile.connection_count} href="/connections" /> : null}
      </div>
      {profile.graph_counts_error ? (
        <Alert tone="warning" className="mt-4">{profile.graph_counts_error}</Alert>
      ) : null}
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
      {skills || interests || profile.bio ? (
        <div className="min-w-0 space-y-7">
          {skills ? <Section title="Skills">{skills}</Section> : null}
          {interests ? <Section title="Interests">{interests}</Section> : null}
          {profile.bio ? (
            <Section title="About">
              <p className="max-w-prose whitespace-pre-line text-ink">{profile.bio}</p>
            </Section>
          ) : null}
        </div>
      ) : null}
      <aside className={skills || interests || profile.bio ? 'min-w-0' : 'min-w-0 lg:col-span-2'}>
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
      </aside>
      </div>

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
