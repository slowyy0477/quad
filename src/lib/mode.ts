/**
 * Which data mode this build runs in.
 *
 * `local`    — accounts and content live in `data/local.json` on this machine.
 *              No network, no Supabase, nothing deployed.
 * `supabase` — the real deployment: Postgres, row-level security, Realtime.
 *
 * The switch is an env var so the same code runs both ways and the Supabase paths
 * stay exercised by `npm run verify` even while the site is being reviewed locally.
 *
 * Read through a literal property access so the bundler can inline it in Client
 * Components as well as the server.
 */
export function isLocalMode(): boolean {
  return process.env.NEXT_PUBLIC_DATA_MODE === 'local'
}

/**
 * True when this deployment must not be reachable by anyone but its owner.
 *
 * Local mode has no row-level security, no rate limiting in the database and no
 * verified identity: it exists for building and reviewing an interface. A
 * production deployment that finds itself in local mode is a configuration
 * mistake with a security consequence, so it refuses to serve instead of quietly
 * behaving like a personal notebook on the public internet.
 */
export function assertNotDeployedInLocalMode(): void {
  const privateDemoOverride =
    process.env.BULLA_ALLOW_LOCAL_IN_PRODUCTION ?? process.env.QUAD_ALLOW_LOCAL_IN_PRODUCTION
  if (isLocalMode() && process.env.NODE_ENV === 'production' && privateDemoOverride !== '1') {
    throw new Error(
      'Refusing to serve a production build in local mode. Local mode stores accounts in a ' +
        'plain JSON file with no row-level security. Set NEXT_PUBLIC_DATA_MODE=supabase and ' +
        'configure a Supabase project, or set BULLA_ALLOW_LOCAL_IN_PRODUCTION=1 only for ' +
        'a private, loopback-bound review. The local store is not a production database.',
    )
  }
}
