/**
 * Safe destinations for a post-auth redirect.
 *
 * An unvalidated `?next=` is an open redirect, and an open redirect on a login
 * page is a phishing primitive: the attacker sends a victim to the real Quad
 * login URL, the victim signs in on the genuine domain, and the app then hands
 * them to `https://quad-login.example/`, which asks them to sign in "again".
 *
 * So a destination is accepted only if it is a path on this origin. Rejected:
 * absolute URLs, protocol-relative `//evil.example` (which a browser resolves as
 * a host, not a path), backslash variants that some parsers normalise to slashes,
 * and anything carrying a control character that could confuse a parser or
 * smuggle a header.
 */
export const DEFAULT_DESTINATION = '/feed'

/** C0 controls and DEL. Written as escapes so they are visible in a diff. */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]')

export function safeRedirect(next: string | null | undefined, fallback = DEFAULT_DESTINATION) {
  if (!next) return fallback
  if (!next.startsWith('/')) return fallback
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (CONTROL_CHARACTERS.test(next)) return fallback
  return next
}
