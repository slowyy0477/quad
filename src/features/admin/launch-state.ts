/**
 * The launch state, in one place.
 *
 * `robots.index = false` is set in src/app/layout.tsx, and docs/DEPLOYMENT.md
 * makes removing it a blocking launch-checklist item with a warning attached: "a
 * half-built site in search results is harder to undo than to prevent". Two files
 * now have to agree about that — layout.tsx's metadata and this constant, which
 * src/app/robots.ts and src/app/sitemap.ts read.
 *
 * Why it is not just read from layout.tsx: a route module cannot import a
 * metadata object out of another route module without dragging the layout's
 * component tree into a `robots.txt` handler. So the state lives here, and
 * layout.tsx is the second place that must change at launch. That is a real
 * duplication and it is written down rather than hidden:
 *
 *   AT LAUNCH — change both.
 *     1. `launched: true` below.
 *     2. Remove `robots: { index: false, follow: false }` from src/app/layout.tsx.
 *
 * The launch checklist in DEPLOYMENT.md should get a third line: confirm
 * `curl -s https://<domain>/robots.txt` no longer says `Disallow: /`.
 */
export const LAUNCH_STATE = {
  /**
   * False until the blocking items in DEPLOYMENT.md are done. While false,
   * robots.txt disallows everything and the sitemap is empty — a sitemap
   * advertising URLs on a site that also says "do not crawl me" is a
   * contradiction, and search engines resolve contradictions the wrong way.
   */
  launched: false,

  /** Why, said plainly, so the next reader does not have to guess. */
  reason:
    'Quad is not launched. The blocking items in docs/DEPLOYMENT.md are not all ' +
    'done, and a half-built site in search results is harder to undo than to prevent.',
} as const

export type LaunchState = typeof LAUNCH_STATE

/** True when the site may be crawled and listed. */
export function isIndexable(): boolean {
  return LAUNCH_STATE.launched
}
