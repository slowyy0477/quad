import type { NextConfig } from 'next'
import { securityHeaders } from './src/lib/security-headers'
export { contentSecurityPolicy, securityHeaders } from './src/lib/security-headers'

const nextConfig: NextConfig = {
  // Review builds can use a dedicated, ignored junction into the D-drive task
  // workspace without replacing the owner's existing .next output.
  distDir: process.env.BULLA_NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  devIndicators: false,
  // Development records/credentials are runtime-owned, not serverless assets.
  // The local adapter is disabled for public serving; do not package its data
  // even when compiling a private preview. Keep required package assets traced.
  outputFileTracingExcludes: {
    '/*': ['.env', '.env.*', 'data/**/*', 'credentials/**/*', '.scratch/**/*', '.claude/**/*'],
  },
  // Keep the private laptop build bounded. Public scaling requires a real DB,
  // a server deployment and measured traffic; this is not a capacity claim.
  experimental: { cpus: 1 },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders() },
      { source: '/sw.js', headers: [
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ] },
      { source: '/offline.html', headers: [{ key: 'Cache-Control', value: 'public, max-age=3600' }] },
    ]
  },
}
export default nextConfig
