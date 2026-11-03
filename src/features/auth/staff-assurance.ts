import 'server-only'

import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { readStore } from '@/lib/local/db'
import { getLocalUser } from '@/lib/local/session'
import { createClient } from '@/lib/supabase/server'

export type StaffAssurance =
  | { state: 'signed_out' | 'unavailable' }
  | { state: 'not_staff' | 'mfa_required' | 'verified' | 'local_unsupported'; userId: string }

/**
 * Reusable main-integrator hook, not an exported Server Action. Roles come from
 * the owner-scoped role table, never editable user_metadata. Ordinary users
 * return not_staff; unavailable checks fail closed. It does not grant a role.
 *
 * Wire this into staff routes AND actions, with TOTP enrollment/challenge and
 * corresponding direct-API/RLS assurance checks. Those routes are outside this
 * account slice; simply enabling TOTP does not enforce staff MFA.
 */
export async function getStaffAssurance(): Promise<StaffAssurance> {
  try {
    if (isLocalMode()) {
      const user = await getLocalUser()
      if (!user) return { state: 'signed_out' }
      const db = await readStore()
      return {
        state: db.user_roles.some((role) => role.user_id === user.id &&
          (role.role === 'admin' || role.role === 'moderator')) ? 'local_unsupported' : 'not_staff',
        userId: user.id,
      }
    }
    if (!isSupabaseConfigured()) return { state: 'unavailable' }
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) return { state: 'signed_out' }
    const { data: roles, error: roleError } = await supabase.from('user_roles')
      .select('role').eq('user_id', data.user.id)
    if (roleError || !roles) return { state: 'unavailable' }
    if (!roles.some((role) => role.role === 'admin' || role.role === 'moderator')) {
      return { state: 'not_staff', userId: data.user.id }
    }
    const { data: verified, error: claimsError } = await supabase.auth.getClaims()
    if (claimsError || verified?.claims.sub !== data.user.id) return { state: 'unavailable' }
    return { state: verified.claims.aal === 'aal2' ? 'verified' : 'mfa_required', userId: data.user.id }
  } catch {
    return { state: 'unavailable' }
  }
}
