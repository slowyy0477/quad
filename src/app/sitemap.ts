import type { MetadataRoute } from 'next'
import { getIndexableUrls } from '@/features/admin/queries'
import { LAUNCH_STATE } from '@/features/admin/launch-state'
import { isSupabaseConfigured, siteUrl } from '@/lib/env'

/**
 * sitemap.xml.
 *
 * Three kinds of URL and nothing else: public profiles, public projects, and the
 * events list. It is built from what is *listed* rather than from a list of
 * exclusions, which is the property that matters — a sitemap written as "every
 * route except the private ones" starts leaking the moment somebody adds a route
 * and forgets. Nothing in src/features/admin/queries.ts can even express an admin
 * or message URL.
 *
 * Every query behind it runs under the anonymous RLS, so the rows that come back
 * are the rows the public may read: `profiles_select_visible` admits an active,
 * public profile and nothing else.
 *
 * `force-dynamic` because the sitemap is a query over live data, and because a
 * crawler fetching a cached sitemap from before a launch-state change would be
 * told about URLs the site then refuses to serve.
 */
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  /*
   * Before launch this is an empty sitemap, not a disallowed one. `robots.txt`
   * already refuses everything, and an empty index is the truthful answer to "what
   * should be crawled" while the answer is "nothing". Returning a 404 would be
   * a second, confusing signal.
   */
  if (!LAUNCH_STATE.launched) return []

  // A build or a preview with no Supabase configuration: an empty sitemap is the
  // honest answer, and creating a client here would throw and fail the render.
  if (!isSupabaseConfigured()) return []

  const { data, error } = await getIndexableUrls()

  if (error) {
    // Logged and empty rather than thrown: a sitemap is not a page a reader is
    // waiting on, and a 500 here tells a crawler the whole site is broken.
    console.error('[sitemap]', error)
    return []
  }

  const origin = siteUrl()
  // One timestamp for the whole file. The rows do not carry a "changed" moment
  // that is reliable for every kind — a profile's `updated_at` moves when the
  // reader changes their bio, not when anything crawlable changed — and a
  // `lastModified` that is invented is worse than none, so the ones below carry
  // only what is truly known: that these URLs exist now.
  const now = new Date()

  const urls: MetadataRoute.Sitemap = [
    ...data.profiles.map((path) => ({
      url: `${origin}${path}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...data.projects.map((path) => ({
      url: `${origin}${path}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...data.events.map((path) => ({
      url: `${origin}${path}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
  ]

  if (data.truncated) {
    // Honest rather than silent: the file is not the whole site, and whoever
    // reads the log should know before wondering why a profile is missing.
    console.error(
      '[sitemap] a list hit its fetch cap, so this sitemap is incomplete. ' +
        'Pagination for the sitemap is outstanding work.',
    )
  }

  return urls
}
