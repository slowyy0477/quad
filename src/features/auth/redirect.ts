/**
 * Safe destinations for a post-auth redirect.
 *
 * An unvalidated `?next=` is an open redirect, and an open redirect on a login
 * page is a phishing primitive: the attacker sends a victim to the real Bulla
 * login URL, the victim signs in on the genuine domain, and the app then hands
 * them to `https://bulla-login.example/`, which asks them to sign in "again".
 *
 * So a destination is accepted only if it is a path on this origin. Rejected:
 * absolute URLs, protocol-relative `//evil.example` (which a browser resolves as
 * a host, not a path), backslash variants that some parsers normalise to slashes,
 * and anything carrying a control character that could confuse a parser or
 * smuggle a header.
 */
export const DEFAULT_DESTINATION = '/feed'

/** C0 controls, DEL and backslashes, at every URL-decoding layer. */
const UNSAFE_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f\\\\]')

export function safeRedirect(next: string | null | undefined, fallback = DEFAULT_DESTINATION) {
  if (!next || next.length > 2048) return fallback
  let value = next
  for (let depth = 0; depth < 8; depth += 1) {
    if (!value.startsWith('/') || value.startsWith('//') || UNSAFE_CHARACTERS.test(value)) return fallback
    try {
      if (new URL(value, 'https://redirect.invalid').pathname.startsWith('//')) return fallback
      const decoded = decodeURIComponent(value)
      if (decoded === value) return next
      value = decoded
    } catch {
      return fallback
    }
  }
  return fallback
}
