'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { PasswordInput } from './password-input'
import {
  changePasswordAction,
  recoverPasswordAction,
  revokePasswordSessionsAction,
} from '@/features/auth/password-actions'
import { emptyPasswordState } from '@/features/auth/password-state'

export function PasswordChangeForm({ recovery = false, email }: { recovery?: boolean; email?: string }) {
  const [state, action, pending] = useActionState(
    recovery ? recoverPasswordAction : changePasswordAction,
    emptyPasswordState,
  )
  if (state.status === 'changed_unrevoked') {
    return (
      <div className="space-y-4">
        <Alert tone="warning">{state.message}</Alert>
        <form action={revokePasswordSessionsAction}>
          <SubmitButton variant="primary" block pendingLabel="Signing out all devices…">
            Retry sign-out on all devices
          </SubmitButton>
        </form>
      </div>
    )
  }
  if (state.recoveryInvalid) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">{state.message}</Alert>
        <Link href="/reset-password" className="inline-flex min-h-11 items-center font-medium text-accent-700 underline">
          Request a new recovery link
        </Link>
      </div>
    )
  }
  return (
    <form action={action} className="space-y-5" noValidate aria-busy={pending}>
      {state.message ? <Alert tone="danger">{state.message}</Alert> : null}
      {email ? (
        <div className="sr-only">
          <label htmlFor="password-account">Account email</label>
          <Input id="password-account" name="accountEmail" autoComplete="username" value={email} readOnly tabIndex={-1} />
        </div>
      ) : null}
      {!recovery ? (
        <Field id="currentPassword" label="Current password" error={state.fieldErrors?.currentPassword} required>
          {(field) => (
            <PasswordInput {...field} name="currentPassword" autoComplete="current-password"
              autoCapitalize="none" spellCheck={false} maxLength={1024} disabled={pending} />
          )}
        </Field>
      ) : null}
      <Field id="password" label="New password"
        hint="At least 15 characters. Use a unique phrase; spaces and password managers are welcome."
        error={state.fieldErrors?.password} required>
        {(field) => (
          <PasswordInput {...field} name="password" autoComplete="new-password"
            autoCapitalize="none" spellCheck={false} maxLength={128} disabled={pending} />
        )}
      </Field>
      <Field id="confirm" label="Repeat new password" error={state.fieldErrors?.confirm} required>
        {(field) => (
          <PasswordInput {...field} name="confirm" autoComplete="new-password"
            autoCapitalize="none" spellCheck={false} maxLength={128} disabled={pending} />
        )}
      </Field>
      <p className="text-sm text-ink-muted">
        Changing your password signs out all devices, including this one. Sign in again with your new password.
      </p>
      <SubmitButton variant="primary" block pendingLabel={recovery ? 'Verifying link and saving…' : 'Changing password…'}>
        {recovery ? 'Verify link and set new password' : 'Change password'}
      </SubmitButton>
    </form>
  )
}
