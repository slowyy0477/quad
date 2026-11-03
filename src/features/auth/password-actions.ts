'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { createClient } from '@/lib/supabase/server'
import { getLocalUser } from '@/lib/local/session'
import { changeLocalPassword } from '@/lib/local/password'
import { changePasswordSchema, cloudPasswordSchema, newPasswordSchema } from './schemas'
import { clearRecoveryToken, freshRecoveryClaims, pendingRecoveryToken } from './recovery'
import { getAuthCapabilities } from './providers'
import type { PasswordFormState } from './password-state'

function errorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }): PasswordFormState {
  const fieldErrors: NonNullable<PasswordFormState['fieldErrors']> = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (key === 'currentPassword' || key === 'password' || key === 'confirm') {
      fieldErrors[key] ??= issue.message
    }
  }
  return { status: 'error', fieldErrors }
}

function changed(): never {
  revalidatePath('/', 'layout')
  redirect('/settings/password?changed=1')
}

async function discardRecoveryToken() {
  try { await clearRecoveryToken() } catch {
    // Provider one-time consumption, never cookie removal, is replay protection.
  }
}

/** Signed-in change: a verified account identity plus its current password. */
export async function changePasswordAction(
  _previous: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword') ?? '',
    password: formData.get('password') ?? '',
    confirm: formData.get('confirm') ?? '',
  })
  if (!parsed.success) return errorsOf(parsed.error)

  if (isLocalMode()) {
    try {
      const actor = await getLocalUser()
      if (!actor) return { status: 'error', message: 'Sign in again before changing your password.' }
      const result = await changeLocalPassword({
        expectedUserId: actor.id,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.password,
      })
      if (!result.ok) {
        if (result.reason === 'invalid_password') {
          return { status: 'error', fieldErrors: { currentPassword: 'Your current password is incorrect.' } }
        }
        if (result.reason === 'same_password') {
          return { status: 'error', fieldErrors: { password: 'Choose a different new password.' } }
        }
        if (result.reason === 'throttled') {
          return { status: 'error', message: `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.` }
        }
        return { status: 'error', message: 'Your session or password is no longer valid. Sign in again and retry.' }
      }
    } catch {
      return { status: 'error', message: 'Your password could not be changed in the local store. Please try again.' }
    }
    changed()
  }

  if (!isSupabaseConfigured()) {
    return { status: 'error', message: 'No cloud account service is configured. Password changes are unavailable.' }
  }
  const cloudPolicy = cloudPasswordSchema.safeParse(parsed.data.password)
  if (!cloudPolicy.success) return errorsOf({
    issues: cloudPolicy.error.issues.map((issue) => ({ ...issue, path: ['password'] })),
  })

  let passwordChanged = false
  try {
    const supabase = await createClient()
    const { data: current, error: userError } = await supabase.auth.getUser()
    if (userError || !current.user?.email) {
      return { status: 'error', message: 'Sign in again before changing your password.' }
    }
    const expectedUserId = current.user.id
    // Reauthenticate even if the hosted current_password setting was not applied.
    // Email is server-derived; posted email/account IDs are never used.
    const { data: reauthenticated, error: authError } = await supabase.auth.signInWithPassword({
      email: current.user.email,
      password: parsed.data.currentPassword,
    })
    if (authError) {
      return authError.code === 'invalid_credentials'
        ? { status: 'error', fieldErrors: { currentPassword: 'Your current password is incorrect.' } }
        : { status: 'error', message: 'The account service could not reauthenticate you. Try again, or use a fresh recovery link.' }
    }
    if (reauthenticated.user?.id !== expectedUserId || !reauthenticated.session) {
      await supabase.auth.signOut({ scope: 'local' })
      return { status: 'error', message: 'The reauthenticated account did not match your session. Nothing was changed.' }
    }
    const { error } = await supabase.auth.updateUser({
      password: parsed.data.password,
      current_password: parsed.data.currentPassword,
    })
    if (error) {
      if (error.code === 'same_password' || error.code === 'weak_password') {
        return { status: 'error', fieldErrors: { password: 'The account service rejected that password. Choose a different, longer phrase.' } }
      }
      return { status: 'error', message: 'The account service could not change your password. Please try again.' }
    }
    passwordChanged = true
    await discardRecoveryToken()
    const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' })
    if (revokeError) {
      return {
        status: 'changed_unrevoked',
        message: 'Your password changed, but the account service could not sign out all devices. Retry session sign-out below.',
      }
    }
  } catch {
    return passwordChanged
      ? { status: 'changed_unrevoked', message: 'Your password changed, but session sign-out was not confirmed. Retry below.' }
      : { status: 'error', message: 'The account service is unavailable. Your password change was not confirmed; please try again.' }
  }
  changed()
}

/**
 * Recovery authority comes from ONE successful provider token redemption in this
 * POST, not a URL flag, ordinary cookie session, email address, or redirectType.
 */
export async function recoverPasswordAction(
  _previous: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const capabilities = await getAuthCapabilities()
  if (!capabilities.emailRecovery) {
    return { status: 'error', message: capabilities.recoveryUnavailableReason ?? 'Email recovery is unavailable.' }
  }
  const parsed = newPasswordSchema.safeParse({
    password: formData.get('password') ?? '',
    confirm: formData.get('confirm') ?? '',
  })
  if (!parsed.success) return errorsOf(parsed.error)
  const policy = cloudPasswordSchema.safeParse(parsed.data.password)
  if (!policy.success) return errorsOf({
    issues: policy.error.issues.map((issue) => ({ ...issue, path: ['password'] })),
  })

  const token = await pendingRecoveryToken()
  if (!token) {
    return { status: 'error', recoveryInvalid: true, message: 'Open a fresh recovery link from your email. An ordinary sign-in cannot reset your password.' }
  }
  await discardRecoveryToken()
  let redeemed = false
  let passwordChanged = false
  let supabase: Awaited<ReturnType<typeof createClient>> | undefined
  try {
    supabase = await createClient()
    const { data, error } = await supabase.auth.verifyOtp({ type: 'recovery', token_hash: token })
    if (error || !data.session || !data.user) {
      return { status: 'error', recoveryInvalid: true, message: 'That recovery link expired or was already used. Request a new one.' }
    }
    redeemed = true
    const accessToken = data.session.access_token
    const [userResult, claimsResult] = await Promise.all([
      supabase.auth.getUser(accessToken),
      supabase.auth.getClaims(accessToken),
    ])
    if (userResult.error || claimsResult.error ||
        userResult.data.user?.id !== data.user.id ||
        data.session.user.id !== data.user.id ||
        !freshRecoveryClaims(claimsResult.data?.claims, data.user.id)) {
      await supabase.auth.signOut({ scope: 'local' })
      return { status: 'error', recoveryInvalid: true, message: 'A fresh recovery session could not be verified. Request a new recovery link.' }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: parsed.data.password })
    if (updateError) {
      await supabase.auth.signOut({ scope: 'local' })
      return {
        status: 'error', recoveryInvalid: true,
        message: 'The account service did not accept the new password. This link has been used; request another link and choose a different phrase.',
      }
    }
    passwordChanged = true
    const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' })
    if (revokeError) {
      return { status: 'changed_unrevoked', message: 'Your password changed, but all-device sign-out was not confirmed. Retry below.' }
    }
  } catch {
    if (passwordChanged) {
      return { status: 'changed_unrevoked', message: 'Your password changed, but all-device sign-out was not confirmed. Retry below.' }
    }
    if (redeemed && supabase) {
      try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* Keep reset authority consumed. */ }
    }
    return { status: 'error', recoveryInvalid: true, message: 'Recovery did not complete. Request a fresh link and try again.' }
  }
  changed()
}

/** A usable retry when password replacement succeeded but global sign-out failed. */
export async function revokePasswordSessionsAction(): Promise<void> {
  if (isLocalMode() || !isSupabaseConfigured()) redirect('/settings/password')
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) redirect('/login?next=/settings/password')
  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' })
  if (revokeError) redirect('/settings/password?error=revocation')
  await discardRecoveryToken()
  changed()
}
