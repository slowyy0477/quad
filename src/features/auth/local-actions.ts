import 'server-only'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { safeRedirect } from '@/features/auth/redirect'
import { signInSchema, signUpSchema } from '@/features/auth/schemas'
import type { AuthFormState } from '@/features/auth/form-state'
import { ensureSeeded } from '@/lib/local/seed'
import { checkCredentials, createAccount, endSession, startSession } from '@/lib/local/session'

/**
 * Auth in local mode.
 *
 * The same validation schemas, the same `next` handling and the same form state as
 * the Supabase path — because a form should not behave differently depending on
 * which store is behind it. What differs is only the store.
 *
 * Sign-in failure says the same thing whichever part was wrong ("that email or
 * password is incorrect"), for the same reason the Supabase path does: naming the
 * wrong one turns the form into an account-existence oracle.
 */

function fieldErrorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

export async function localSignInAction(formData: FormData): Promise<AuthFormState> {
  await ensureSeeded()

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

  const user = await checkCredentials(parsed.data.email, parsed.data.password)
  if (!user) {
    return {
      status: 'error',
      message: 'That email or password is incorrect.',
      values: { email: raw.email },
    }
  }

  await startSession(user.id)
  revalidatePath('/', 'layout')
  redirect(safeRedirect(String(formData.get('next') ?? '')))
}

export async function localSignUpAction(formData: FormData): Promise<AuthFormState> {
  await ensureSeeded()

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

  const created = await createAccount({
    email: parsed.data.email,
    password: parsed.data.password,
    displayName: parsed.data.displayName,
  })

  if (!created) {
    return {
      status: 'error',
      message: 'An account with that email already exists. Try signing in instead.',
      values: { email: raw.email, displayName: raw.displayName },
    }
  }

  // No email confirmation exists in local mode, so there is nothing to wait for:
  // the account is signed in immediately and sent to finish its profile.
  await startSession(created.user.id)
  revalidatePath('/', 'layout')
  redirect('/onboarding')
}

export async function localSignOutAction(): Promise<void> {
  await endSession()
  revalidatePath('/', 'layout')
  redirect('/')
}
