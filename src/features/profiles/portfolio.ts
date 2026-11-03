import 'server-only'

import { canReadContent, canReadProfile, localActor } from '@/lib/local/access'
import { readStore, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { createClient, getUser } from '@/lib/supabase/server'
import { localCanViewPost } from '@/features/feed/queries'
import { canSeeProject } from '@/features/projects/queries'
import { firstValue, type DiscoveryParams } from '@/features/search/filters'
import {
  belowKeyset, boundedPageSize, decodeKeysetCursor, encodeKeysetCursor,
  hostedKeysetFilter, keysetPage, keysetScope, newestFirst, validDiscoveryId,
} from '@/features/search/paging'

export const PORTFOLIO_SECTIONS = ['projects', 'ideas', 'goals', 'posts'] as const
export type PortfolioSection = (typeof PORTFOLIO_SECTIONS)[number]
export const PORTFOLIO_CURSOR_PARAMS: Record<PortfolioSection, string> = {
  projects: 'portfolio_projects', ideas: 'portfolio_ideas',
  goals: 'portfolio_goals', posts: 'portfolio_posts',
}
export type PortfolioCursors = Partial<Record<PortfolioSection, string | string[] | undefined>>

/** Small readable DTO. No ownership/learning/engagement totals or raw anchors. */
export type PortfolioEntry = {
  id: string
  title: string
  excerpt: string | null
  /** null for goals: Bulla has no public goal-detail route. Read them inline. */
  href: string | null
  status: string | null
  visibility: string
  created_at: string
  target_date: string | null
}

export type PortfolioPage = {
  items: PortfolioEntry[] | null
  cursor: string | null
  nextCursor: string | null
  error: string | null
}

export type ProfilePortfolio = {
  profileId: string
  username: string
  /** Derived from the verified reader, never supplied by a caller. */
  isSelf: boolean
} & Record<PortfolioSection, PortfolioPage>

export type PortfolioResult = { portfolio: ProfilePortfolio | null; error: string | null }

export function parsePortfolioCursors(params: DiscoveryParams): PortfolioCursors {
  return Object.fromEntries(PORTFOLIO_SECTIONS.map((section) =>
    [section, firstValue(params[PORTFOLIO_CURSOR_PARAMS[section]])]))
}

type HostedEntry = {
  id: string
  created_at: string
  visibility: string
  title?: string
  body?: string
  slug?: string
  tagline?: string | null
  description?: string | null
  status?: string
  target_date?: string | null
}

const READS = {
  projects: { owner: 'owner_id', columns: 'id, slug, title, tagline, status, visibility, created_at' },
  ideas: { owner: 'author_id', columns: 'id, title, description, status, visibility, created_at' },
  goals: { owner: 'profile_id', columns: 'id, title, description, status, visibility, target_date, created_at' },
  posts: { owner: 'author_id', columns: 'id, body, visibility, created_at' },
} as const

function entry(section: PortfolioSection, row: HostedEntry): PortfolioEntry {
  const text = section === 'posts' ? row.body?.trim() ?? '' : row.title ?? ''
  return {
    id: row.id,
    title: text.slice(0, section === 'posts' ? 80 : 160) || 'Post',
    excerpt: (section === 'posts' ? row.body?.trim() : section === 'projects'
      ? row.tagline?.trim() : row.description?.trim())?.slice(0, 240) || null,
    href: section === 'projects' && row.slug ? `/projects/${encodeURIComponent(row.slug)}`
      : section === 'ideas' ? `/ideas/${encodeURIComponent(row.id)}`
      : section === 'posts' ? `/post/${encodeURIComponent(row.id)}` : null,
    status: row.status ?? null, visibility: row.visibility, created_at: row.created_at,
    target_date: section === 'goals' ? row.target_date ?? null : null,
  }
}

function localEntries(
  db: Tables, profileId: string, viewer: ReturnType<typeof localActor>, section: PortfolioSection,
): PortfolioEntry[] {
  switch (section) {
    case 'projects':
      return db.projects.filter((row) => row.owner_id === profileId && canSeeProject(db, row, viewer))
        .map((row) => entry(section, { ...row, tagline: row.purpose }))
    case 'ideas':
      return db.ideas.filter((row) => row.author_id === profileId &&
        canReadContent(db, row, profileId, viewer, 'idea'))
        .map((row) => entry(section, row))
    case 'goals':
      // The already-checked profile plus each goal's OWN visibility contract.
      // Never read courses/semesters/logs/milestones to infer private learning.
      return db.goals.filter((row) => row.profile_id === profileId &&
        canReadContent(db, row, profileId, viewer, 'goal'))
        .map((row) => entry(section, row))
    case 'posts':
      return db.posts.filter((row) => row.author_id === profileId &&
        localCanViewPost(row, viewer, db.profiles.find((profile) => profile.id === profileId), db))
        .map((row) => entry(section, row))
  }
}

/** Bounded lists under the reader's own permissions; hidden and absent are identical. */
export async function getProfilePortfolio(
  profileId: string,
  { limit, cursors = {} }: { limit?: number; cursors?: PortfolioCursors } = {},
): Promise<PortfolioResult> {
  const local = isLocalMode()
  if (!validDiscoveryId(profileId, local)) return { portfolio: null, error: null }
  const size = boundedPageSize(limit, 6, 12)

  try {
    const user = await getUser()
    if (local) {
      const db = await readStore()
      const viewer = localActor(db, user?.id ?? null)
      const profile = db.profiles.find((row) => row.id === profileId)
      if (!profile || !canReadProfile(db, profile, viewer)) return { portfolio: null, error: null }
      const pages = Object.fromEntries(PORTFOLIO_SECTIONS.map((section) => {
        const scope = keysetScope(['portfolio', profileId, section])
        const after = decodeKeysetCursor(cursors[section], scope, true)
        const rows = localEntries(db, profileId, viewer, section)
          .filter((row) => !after || belowKeyset(row, after))
          .sort(newestFirst).slice(0, size + 1)
        return [section, {
          ...keysetPage(rows, size, scope),
          cursor: after ? encodeKeysetCursor(after, scope) : null,
          error: null,
        }]
      })) as Record<PortfolioSection, PortfolioPage>
      return {
        portfolio: { profileId, username: profile.username, isSelf: viewer?.id === profileId, ...pages },
        error: null,
      }
    }

    const supabase = await createClient()
    const profileRead = await supabase.from('profiles').select('id, username, status, suspended_until')
      .eq('id', profileId).is('deleted_at', null)
      .maybeSingle<{ id: string; username: string; status: string; suspended_until: string | null }>()
    if (profileRead.error) return { portfolio: null, error: 'The portfolio could not be loaded. Please try again.' }
    if (!profileRead.data) return { portfolio: null, error: null }
    const profile = profileRead.data
    const expiredSuspension = profile.status === 'suspended' && profile.suspended_until !== null &&
      Number.isFinite(Date.parse(profile.suspended_until)) && Date.parse(profile.suspended_until) <= Date.now()
    if (profile.status !== 'active' && !expiredSuspension) return { portfolio: null, error: null }

    const pairs = await Promise.all(PORTFOLIO_SECTIONS.map(async (section) => {
      const scope = keysetScope(['portfolio', profileId, section])
      const after = decodeKeysetCursor(cursors[section], scope, false)
      const spec = READS[section]
      let query = supabase.from(section).select(spec.columns).eq(spec.owner, profileId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(size + 1)
      if (section !== 'goals') query = query.is('deleted_at', null).eq('moderation_status', 'active')
      if (after) query = query.or(hostedKeysetFilter(after))
      const { data, error } = await query.returns<HostedEntry[]>()
      const page: PortfolioPage = error ? {
        items: null, nextCursor: null, cursor: null,
        error: `These ${section} could not be loaded. Please try again.`,
      } : {
        ...keysetPage((data ?? []).map((row) => entry(section, row)), size, scope),
        cursor: after ? encodeKeysetCursor(after, scope) : null,
        error: null,
      }
      return [section, page] as const
    }))
    const pages = Object.fromEntries(pairs) as Record<PortfolioSection, PortfolioPage>
    return {
      portfolio: {
        profileId, username: profileRead.data.username, isSelf: user?.id === profileId, ...pages,
      },
      error: null,
    }
  } catch {
    console.error('[profiles:portfolio] read failed')
    return { portfolio: null, error: 'The portfolio could not be loaded. Please try again.' }
  }
}
