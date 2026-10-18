import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'

/**
 * Site operations reads.
 *
 * Two things live here, and they share a home because they share an audience:
 * a person operating the site.
 *
 *   1. `getStaffRole` — the guard the /admin routes re-check on every page.
 *   2. `getIndexableUrls` — the reads behind src/app/sitemap.ts.
 *
 * The sitemap's reads are here rather than in a feature module because the
 * coverage spans three domains — profiles, projects and events — and none of them
 * owns the answer. Putting it in `features/profiles/queries.ts` would mean the
 * profiles module exporting "every URL a crawler may fetch", which is not a
 * question about profiles.
 */

export type StaffRole = 'admin' | 'moderator'

/**
 * The role this request's user holds, or null.
 *
 * This is the /admin guard, and it is deliberately a *read of the caller's own
 * roles* rather than a check of anything the request claims. `user_roles` is
 * readable by its owner (0002) and writable by nobody, so the answer cannot be
 * influenced by the client.
 *
 * Every /admin page calls this for itself. The layout calls it too, but a layout
 * is not a boundary — a page can be rendered without its layout in some error
 * paths, and "the layout checked" is exactly the reasoning that puts an
 * unguarded page behind a hidden link.
 *
 * The proxy redirects signed-out visitors away from /admin. That is a
 * convenience, not this check: a request that never passes through the proxy
 * reaches the page directly, and SECURITY.md §2.1 is explicit that its redirect
 * protects nothing.
 */
export async function getStaffRole(): Promise<StaffRole | null> {
  const user = await getUser()
  if (!user) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .returns<{ role: string }[]>()

  if (error) {
    // Fail closed. A guard that returns "allowed" when it cannot tell is not a
    // guard, and the failure it produces is silent.
    console.error('[admin:getStaffRole]', error.code, error.message)
    return null
  }

  const roles = (data ?? []).map((row) => row.role)
  if (roles.includes('admin')) return 'admin'
  if (roles.includes('moderator')) return 'moderator'
  return null
}

/** An administrator, for the surfaces only the maintainer should reach. */
export async function getAdminRole(): Promise<'admin' | null> {
  const role = await getStaffRole()
  return role === 'admin' ? 'admin' : null
}

// ---------------------------------------------------------------------------
// What a crawler may fetch
// ---------------------------------------------------------------------------

export type IndexableUrls = {
  /** `/u/<username>` for every public profile. */
  profiles: string[]
  /** `/projects/<slug>` for every public, active project. */
  projects: string[]
  /** `/events` if there is at least one public scheduled event. */
  events: string[]
  /** True when a list hit the fetch cap, so the sitemap is not the whole site. */
  truncated: boolean
}

/**
 * The public URLs worth listing.
 *
 * Every query runs under the caller's own RLS, and the sitemap is fetched by an
 * anonymous crawler, so the policies do most of the work: profiles_select_visible
 * admits a public active profile and nothing else. The explicit filters repeat
 * that on purpose here — this is the one read where a mistake is *publicity*
 * rather than exposure, and a duplicated rule that fails loudly is better than a
 * rule that quietly depends on a policy staying as it is.
 *
 * Nothing here can reach an admin route, a setting, a message or a draft, because
 * none of them is one of the three shapes being selected. That is the design:
 * the sitemap is built from what is listed, not from what is excluded.
 */
export async function getIndexableUrls(limit = 2000): Promise<{
  data: IndexableUrls
  error: string | null
}> {
  const empty: IndexableUrls = { profiles: [], projects: [], events: [], truncated: false }
  const supabase = await createClient()

  const [profiles, projects, events] = await Promise.all([
    supabase
      .from('profiles')
      .select('username')
      .eq('visibility', 'public')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('last_active_at', { ascending: false })
      .limit(limit)
      .returns<{ username: string }[]>(),
    supabase
      .from('projects')
      .select('slug')
      .eq('visibility', 'public')
      .eq('moderation_status', 'active')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<{ slug: string }[]>(),
    supabase
      .from('events')
      .select('slug')
      .eq('visibility', 'public')
      .eq('status', 'scheduled')
      .eq('moderation_status', 'active')
      .is('deleted_at', null)
      .order('starts_at', { ascending: true })
      .limit(limit)
      .returns<{ slug: string }[]>(),
  ])

  for (const [name, result] of [
    ['profiles', profiles],
    ['projects', projects],
    ['events', events],
  ] as const) {
    if (result.error) {
      console.error('[admin:getIndexableUrls]', name, result.error.code, result.error.message)
      return { data: empty, error: 'The public URLs could not be read.' }
    }
  }

  const profileRows = profiles.data ?? []
  const projectRows = projects.data ?? []
  const eventRows = events.data ?? []

  return {
    data: {
      profiles: profileRows.map((row) => `/u/${row.username}`),
      projects: projectRows.map((row) => `/projects/${row.slug}`),
      /*
       * The events list, not one URL per event, and this is not an oversight:
       * there is no `/events/[slug]` route in src/app yet, and a sitemap that
       * lists a page which 404s is a sitemap that lies to a crawler. The list
       * route is included only when there is something public to list.
       *
       * When the event page is built, replace this with `/events/${row.slug}`.
       */
      events: eventRows.length > 0 ? ['/events'] : [],
      truncated:
        profileRows.length >= limit || projectRows.length >= limit || eventRows.length >= limit,
    },
    error: null,
  }
}
