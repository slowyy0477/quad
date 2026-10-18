import type { MetadataRoute } from 'next'
import { LAUNCH_STATE } from '@/features/admin/launch-state'
import { siteUrl } from '@/lib/env'

/**
 * robots.txt.
 *
 * One decision, read from one constant: while `LAUNCH_STATE.launched` is false,
 * nothing is crawlable. That is not caution for its own sake — src/app/layout.tsx
 * already sets `robots.index = false` for every page, and a robots.txt that said
 * "come in" while every page said "noindex" would be a contradiction. Crawlers
 * resolve it by not indexing the pages *and* remembering that the site invited
 * them, so the eventual launch starts from a confused index.
 *
 * The same constant is read by src/app/sitemap.ts, so the two cannot disagree
 * with each other. What they *can* disagree with is layout.tsx's metadata, which
 * is a second copy of the same fact — see the note in
 * src/features/admin/launch-state.ts. At launch, change both.
 *
 * Before launch the file is a disallow-everything plus a comment saying why. A
 * bare `Disallow: /` with no explanation is read as "temporarily hidden for
 * reasons nobody remembers" and removed by the first person who wants a page
 * indexed.
 */
export default function robots(): MetadataRoute.Robots {
  if (!LAUNCH_STATE.launched) {
    return {
      rules: [
        {
          userAgent: '*',
          disallow: ['/'],
        },
      ],
      // Deliberately no sitemap line: a sitemap URL that returns an empty index
      // invites a crawler to keep asking.
      host: siteUrl(),
    }
  }

  /*
   * After launch.
   *
   * The list is of routes that hold somebody's data or somebody's queue, and it
   * is a belt to `robots: { index: false }` on each of those pages — the page metadata
   * is the thing that works, since robots.txt only asks politely and a page that
   * is linked from a public profile can still be fetched and indexed otherwise.
   */
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/api/',
          '/auth/',
          '/feed',
          '/messages',
          '/notifications',
          '/settings',
          '/report-a-bug',
          '/login',
          '/signup',
          '/reset-password',
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  }
}
