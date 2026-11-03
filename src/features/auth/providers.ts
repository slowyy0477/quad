import 'server-only'

import { isSupabaseConfigured, publicEnv } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'

export type AuthCapabilities = {
  status: 'local' | 'unconfigured' | 'unreachable' | 'configured'
  password: boolean
  google: boolean
  emailRecovery: boolean
  recoveryUnavailableReason: string | null
}

/**
 * Presence of an anon key is NOT proof that Google/email are enabled. Read the
 * provider's public settings using only the public anon key, without user
 * credentials, sessions or cross-user caching.
 * The template flag is a deployment assertion, not authentication authority.
 */
export async function getAuthCapabilities(): Promise<AuthCapabilities> {
  if (isLocalMode()) {
    return {
      status: 'local', password: true, google: false, emailRecovery: false,
      recoveryUnavailableReason:
        'Local accounts have no email recovery. A signed-in account can change its password with the current password; this app cannot recover a forgotten local password.',
    }
  }
  if (!isSupabaseConfigured()) {
    return {
      status: 'unconfigured', password: false, google: false, emailRecovery: false,
      recoveryUnavailableReason: 'No cloud account service is configured. Email recovery is unavailable.',
    }
  }

  try {
    const env = publicEnv()
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) throw new Error('Provider settings unavailable')
    const settings: unknown = await response.json()
    if (!settings || typeof settings !== 'object' || !('external' in settings) ||
        !settings.external || typeof settings.external !== 'object') {
      throw new Error('Invalid provider settings')
    }
    const external = settings.external as Record<string, unknown>
    const password = external.email === true
    const template = process.env.BULLA_RECOVERY_EMAIL_TEMPLATE === 'token_hash'
    return {
      status: 'configured',
      password,
      google: external.google === true,
      emailRecovery: password && template,
      recoveryUnavailableReason: !password
        ? 'Email accounts are disabled by the account provider. Email recovery is unavailable.'
        : !template
          ? 'The one-time recovery email template has not been configured for this deployment. Email recovery is unavailable.'
          : null,
    }
  } catch {
    return {
      status: 'unreachable', password: false, google: false, emailRecovery: false,
      recoveryUnavailableReason: 'The account provider could not be checked. Email recovery is unavailable right now; try again later.',
    }
  }
}
