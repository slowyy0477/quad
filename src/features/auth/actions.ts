'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { AuthError } from '@supabase/supabase-js'
import { isSupabaseConfigured, siteUrl } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { safeRedirect } from '@/features/auth/redirect'
import { resetRequestSchema, signInSchema, signUpSchema } from '@/features/auth/schemas'
import type { AuthFormState } from '@/features/auth/form-state'

/**
 * Auth Server Actions.
 *
 * Three things worth reading before editing this file.
 *
 * 1. Validation happens here, not only in the form. The browser copy of the
 *    schema exists to give fast feedback; this copy exists because a POST to a
 *    Server Action is an ordinary HTTP request that anyone can craft by hand.
 *
 * 2. Errors are translated, never forwarded. Supabase's messages are written for
 *    developers and occasionally leak implementation detail; the brief also
 *    requires that database errors are not shown to users. So `describe()` maps
 *    known cases to plain sentences and everything else to one generic sentence,
 *    with the original logged server-side for whoever has to debug it.
 *
 * 3. Sign-in failure says "email or password is incorrect" without saying which.
 *    Naming the wrong one turns the login form into an account-existence oracle:
 *    an attacker learns which addresses are registered here, which is exactly the
 *    fact they need to go phish those people. Supabase's own generic
 *    `invalid_credentials` is preserved for the same reason.
 */

const UNAVAILABLE: AuthFormState = {
  status: 'error',
  message:
    'Accounts are not available yet on this deployment: it has no database connection configured. See the setup page.',
}

/** Maps a Supabase auth error to something worth showing a person. */
function describe(error: AuthError, context: 'sign-in' | 'sign-up' | 'reset'): string {
  // Logged, not shown. This is the only place the raw message should appear.
  console.error(`[auth:${context}]`, error.code ?? error.status, error.message)

  switch (error.code) {
    case 'invalid_credentials':
      return 'That email or password is incorrect.'
    case 'email_not_confirmed':
      return 'Confirm your email address first — check your inbox for the link we sent.'
    case 'user_already_exists':
    case 'email_exists':
      // Only reachable when Supabase is configured to reveal it. The signup path
      // below prefers the neutral "check your email" response.
      return 'An account with that email already exists. Try signing in instead.'
    case 'weak_password':
      return 'That password is too easy to guess. Try a longer phrase.'
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a few minutes and try again.'
    case 'signup_disabled':
      return 'New accounts are closed at the moment.'
    case 'validation_failed':
      return 'Check the details above and try again.'
    default:
      return 'Something went wrong on our side. Please try again in a moment.'
  }
}

function fieldErrorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

// -----------------------------------------------------------------------------
// Sign in
// -----------------------------------------------------------------------------

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const raw = {
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  }
  const parsed = signInSchema.safeParse(raw)

  if (!parsed.success) {
    return {
      status: 'error',
      fieldErrors: fieldErrorsOf(parsed.error),
      values: { email: raw.email },
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    return {
      status: 'error',
      message: describe(error, 'sign-in'),
      values: { email: raw.email },
    }
  }

  // The layout renders the signed-in header, so the cached shell has to go.
  revalidatePath('/', 'layout')
  redirect(safeRedirect(String(formData.get('next') ?? '')))
}

// -----------------------------------------------------------------------------
// Sign up
// -----------------------------------------------------------------------------

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const raw = {
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
    displayName: String(formData.get('displayName') ?? ''),
    acceptTerms: String(formData.get('acceptTerms') ?? ''),
  }
  const parsed = signUpSchema.safeParse(raw)

  if (!parsed.success) {
    return {
      status: 'error',
      fieldErrors: fieldErrorsOf(parsed.error),
      values: { email: raw.email, displayName: raw.displayName },
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Read by the `on_auth_user_created` trigger in 0004_profiles.sql, which
      // creates the profile row. The username it assigns is a placeholder derived
      // from the user id; onboarding is where a real handle gets chosen.
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: `${siteUrl()}/auth/callback?next=/onboarding`,
    },
  })

  if (error) {
    return {
      status: 'error',
      message: describe(error, 'sign-up'),
      values: { email: raw.email, displayName: raw.displayName },
    }
  }

  // A project with "Confirm email" switched off signs the user in immediately and
  // sends no email at all. Sending them to "check your inbox" would be a dead end
  // waiting for a message that never arrives, so follow the session instead of
  // assuming the project's configuration.
  //
  // This does not weaken the enumeration resistance below. With confirmation on,
  // an existing address and a new one both come back without a session, so both
  // take the same branch. With confirmation off, Supabase answers an existing
  // address with `user_already_exists` — handled above — so the distinction is
  // already visible whatever this code does.
  if (data.session) {
    revalidatePath('/', 'layout')
    redirect('/onboarding')
  }

  // Deliberately the same destination whether or not the address was already
  // registered. Supabase returns a success-shaped response for an existing
  // confirmed address precisely so the form cannot be used to enumerate accounts,
  // and branching on it here would undo that.
  redirect(`/signup/check-email?email=${encodeURIComponent(parsed.data.email)}`)
}

// -----------------------------------------------------------------------------
// Password reset
// -----------------------------------------------------------------------------

export async function requestPasswordResetAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const raw = { email: String(formData.get('email') ?? '') }
  const parsed = resetRequestSchema.safeParse(raw)

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: raw }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl()}/auth/callback?next=/settings/password`,
  })

  // Rate limiting is worth surfacing; "no such user" is not, and Supabase does
  // not distinguish it here either. The page that follows says "if an account
  // exists" rather than "we sent it".
  if (error && (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit')) {
    return { status: 'error', message: describe(error, 'reset'), values: raw }
  }
  if (error) console.error('[auth:reset]', error.code ?? error.status, error.message)

  redirect('/reset-password/sent')
}

// -----------------------------------------------------------------------------
// Google
// -----------------------------------------------------------------------------

export async function signInWithGoogleAction(formData: FormData) {
  if (!isSupabaseConfigured()) redirect('/setup')

  const next = safeRedirect(String(formData.get('next') ?? ''))
  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
      // No extra scopes. Quad needs an identity, not a mailbox or a calendar, and
      // asking for more than that is both a consent-screen deterrent and a
      // liability if the token is ever leaked.
    },
  })

  if (error || !data.url) {
    console.error('[auth:google]', error?.code ?? error?.status, error?.message)
    redirect('/login?error=oauth')
  }

  redirect(data.url)
}

// -----------------------------------------------------------------------------
// Sign out
// -----------------------------------------------------------------------------

export async function signOutAction() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient()
    // 'local' rather than 'global': signing out on a library computer should not
    // also kill the session on the user's phone.
    await supabase.auth.signOut({ scope: 'local' })
  }

  revalidatePath('/', 'layout')
  redirect('/')
}
