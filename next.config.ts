import type { NextConfig } from 'next'

/**
 * Security headers.
 *
 * Written as one function so the strings live in a single place and can be
 * asserted by a test rather than eyeballed in a response.
 *
 * =============================================================================
 * THE CONTENT SECURITY POLICY, AND THE ONE PLACE IT IS WEAK
 * =============================================================================
 *
 * `script-src` contains `'unsafe-inline'`, and the reason is written here because
 * docs/plan/issues.json asks for exactly that: "the policy is not `unsafe-inline`
 * everywhere — the reason for any exception is written next to it".
 *
 * **Why it is there.** Next 16 streams the React Server Component payload to the
 * browser as inline `<script>self.__next_f.push(…)</script>` tags. Those scripts
 * are generated per response and their contents are page data, so no fixed hash
 * can cover them: the payload for /feed and the payload for /admin differ on every
 * request. The supported way to authorise them is a per-response nonce, and Next
 * only attaches a nonce to its own scripts when *middleware* sets the
 * `Content-Security-Policy` header on the **request** — the request header is
 * where Next looks for it (`proxy.ts` is the middleware here, and it is owned by
 * another workstream, so this file cannot add it).
 *
 * Writing `script-src 'self' 'nonce-…'` in `next.config.ts` without that
 * middleware step does not add protection; it produces a page whose flight data is
 * blocked, i.e. a white screen with console errors, which would be caught in
 * testing and reverted — and then there would be no CSP at all. A weaker policy
 * that is deployed beats a stronger one that is reverted.
 *
 * **What it costs.** An injected inline `<script>` would execute if an attacker
 * could get one into the HTML. Three things stand behind that:
 *
 *   1. Nothing in this application renders user content as HTML. The only
 *      `dangerouslySetInnerHTML` in `src/` is the pre-paint theme script in
 *      src/components/ui/theme-script.tsx, whose body is a compiled-in template
 *      literal with no interpolation from the database. The moderation queue — the
 *      page with the most hostile input in the product — renders reported content
 *      as text and says so.
 *   2. `'unsafe-eval'` is *not* granted (except in development, where the dev
 *      server's HMR needs it). React and Supabase do not use `eval`.
 *   3. `connect-src` is pinned to this origin and the Supabase project. Injected
 *      script cannot POST a session token to an attacker's host — the browser will
 *      refuse the request. React escaping plus a closed `connect-src` is a real
 *      reduction in impact, not a reassurance.
 *
 * **How to upgrade it, in one step, when proxy.ts is available.** Generate 16
 * random bytes per request in the proxy, then:
 *
 *     const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
 *     request.headers.set('x-nonce', nonce)             // Next reads this
 *     response.headers.set('Content-Security-Policy', csp({
 *       scriptSrc: `'self' 'nonce-${nonce}' 'strict-dynamic'`,
 *     }))
 *
 * then delete `'unsafe-inline'` from `script-src` below and render it through the
 * shared helper instead. Until that exists, `'unsafe-inline'` in `script-src` is
 * the honest maximum, and every other directive here is strict.
 *
 * `'unsafe-inline'` in `style-src` covers Tailwind's and Radix's runtime-applied
 * inline styles (`style="…"` attributes). Inline styles cannot execute script;
 * the directive is there so dialogs and scroll areas lay out correctly.
 *
 * Note what is *not* set: **Strict-Transport-Security.** HSTS is a promise about a
 * domain that must be honoured for as long as the max-age says, including by
 * subdomains, and there is no domain yet. Add it at launch, with the domain
 * attached, in the same commit as the launch state in
 * src/features/admin/launch-state.ts.
 */

/** The Supabase project's origins, derived from the configured URL. */
function supabaseOrigins(): { https: string | null; wss: string | null } {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return { https: null, wss: null }

  try {
    const url = new URL(raw)
    return { https: url.origin, wss: `wss://${url.host}` }
  } catch {
    // A malformed URL is reported by src/lib/env.ts with a better message than
    // this file could give. All this needs to do is not crash the build.
    return { https: null, wss: null }
  }
}

const isDev = process.env.NODE_ENV !== 'production'

/**
 * The policy. Exported so a test can assert on it without an HTTP server.
 */
export function contentSecurityPolicy(): string {
  const supabase = supabaseOrigins()
  const connect = ["'self'", supabase.https, supabase.wss, isDev ? 'ws://localhost:*' : null]
    .filter(Boolean)
    .join(' ')

  const directives: Record<string, string> = {
    'default-src': "'self'",

    // An injected <base> tag redirects every relative URL on the page, including
    // the ones that load scripts. Cheaper to forbid than to reason about.
    'base-uri': "'self'",

    // No Flash, no Java, no <embed>. Nothing in this application uses them, so
    // the only thing this can block is somebody else's payload.
    'object-src': "'none'",

    // Clickjacking. Also expressed as X-Frame-Options: DENY below, for browsers
    // that predate this directive -- an old browser ignoring CSP still honours
    // the header.
    'frame-ancestors': "'none'",

    // A page here posts to a Server Action on this origin and to nothing else, so
    // an injected form cannot post a reader's data to another host.
    'form-action': "'self'",

    'script-src': isDev
      ? "'self' 'unsafe-inline' 'unsafe-eval'"
      : "'self' 'unsafe-inline'",

    'style-src': "'self' 'unsafe-inline'",

    // Avatars and project images come from Supabase Storage; `data:` covers the
    // inline SVG placeholder Avatar falls back to, `blob:` a pasted screenshot
    // preview.
    'img-src': ["'self'", 'data:', 'blob:', supabase.https].filter(Boolean).join(' '),

    'font-src': "'self' data:",

    // Realtime is a WebSocket to the same project, hence the wss:// origin.
    'connect-src': connect,

    'media-src': ["'self'", supabase.https].filter(Boolean).join(' '),

    'manifest-src': "'self'",
    'worker-src': "'self' blob:",
  }

  // Development is served over http://localhost, where this directive would
  // rewrite every asset URL to https and break the dev server.
  if (!isDev) directives['upgrade-insecure-requests'] = ''

  return Object.entries(directives)
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join('; ')
}

/**
 * Every response gets these.
 *
 * `source: '/(.*)'` rather than a list of paths, because a header that is applied
 * to "the pages we remembered" is missing from the page that gets added next
 * week. The static assets are served by the same rule.
 */
export function securityHeaders(): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy() },

    // The browser must trust Content-Type over sniffing the bytes. Without it, a
    // stored file that a browser decides looks like HTML can execute in the
    // origin's context. Cheap, no downsides.
    { key: 'X-Content-Type-Options', value: 'nosniff' },

    // Older browsers' clickjacking protection, alongside frame-ancestors above.
    { key: 'X-Frame-Options', value: 'DENY' },

    // Send the origin to other sites, but the full path only to this origin.
    // A profile URL contains a username; a post URL contains an id; neither needs
    // to travel to whoever is linked in a post.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

    // Features this application does not use, denied explicitly so that an
    // injected iframe or script cannot ask for them. Camera and microphone are
    // here because the app has no upload-from-camera flow; add them back with a
    // `self` allowance on the day it does, rather than removing them now.
    {
      key: 'Permissions-Policy',
      value: [
        'accelerometer=()',
        'autoplay=()',
        'camera=()',
        'display-capture=()',
        'geolocation=()',
        'gyroscope=()',
        'magnetometer=()',
        'microphone=()',
        'midi=()',
        'payment=()',
        'usb=()',
      ].join(', '),
    },

    // Not HSTS: there is no domain yet. See the note at the top of this file.
  ]
}

const nextConfig: NextConfig = {
  // The version header is a gift to somebody scanning for known CVEs and nothing
  // else. Next's defaults are otherwise fine.
  poweredByHeader: false,

  // The floating dev badge sits over page content in the bottom-left corner — it
  // obscured a callout in a 390px review, and it is not part of the design. Errors
  // still surface through the overlay; this only removes the collapsed indicator.
  devIndicators: false,

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders(),
      },
    ]
  },
}

export default nextConfig
