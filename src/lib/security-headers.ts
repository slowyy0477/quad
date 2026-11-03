export type CspOptions = { production?: boolean; local?: boolean; https?: boolean }

/** Shared by the Next config and the request proxy; nonces are per response. */
export function contentSecurityPolicy(nonce?: string, options: CspOptions = {}): string {
  const production = options.production ?? process.env.NODE_ENV === 'production'
  const local = options.local ?? process.env.NEXT_PUBLIC_DATA_MODE === 'local'
  const https = options.https ?? (process.env.BULLA_REQUIRE_HTTPS ?? process.env.QUAD_REQUIRE_HTTPS) === '1'
  const origins: string[] = []
  if (!local && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL)
      if (url.protocol === 'https:') origins.push(url.origin, `wss://${url.host}`)
    } catch { /* Environment validation reports malformed configuration. */ }
  }
  if (nonce && !/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new Error('Invalid CSP nonce')
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'base-uri': "'self'",
    'object-src': "'none'",
    'frame-ancestors': "'none'",
    'form-action': "'self'",
    'script-src': ["'self'", nonce ? `'nonce-${nonce}' 'strict-dynamic'` : '', production ? '' : "'unsafe-eval'"].filter(Boolean).join(' '),
    // Radix uses inline positioning styles. This exception permits CSS, not JS.
    'style-src': "'self' 'unsafe-inline'",
    'img-src': ["'self'", 'data:', 'blob:', ...origins.filter((origin) => origin.startsWith('https:'))].join(' '),
    'font-src': "'self' data:",
    'connect-src': ["'self'", ...origins, ...(!production ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : [])].join(' '),
    'media-src': "'self' blob:",
    'manifest-src': "'self'",
    'worker-src': "'self'",
  }
  // Never force localhost to HTTPS: only a configured TLS deployment opts in.
  if (https) directives['upgrade-insecure-requests'] = ''
  return Object.entries(directives).map(([name, value]) => value ? `${name} ${value}` : name).join('; ')
}

export function securityHeaders(): { key: string; value: string }[] {
  const result = [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ]
  if ((process.env.BULLA_REQUIRE_HTTPS ?? process.env.QUAD_REQUIRE_HTTPS) === '1') result.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' })
  return result
}
