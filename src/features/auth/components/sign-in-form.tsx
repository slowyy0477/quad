'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { signInAction } from '@/features/auth/actions'
import { emptyAuthState } from '@/features/auth/form-state'

/**
 * Sign-in form.
 *
 * A plain `<form action={...}>` wired to a Server Action, which means it submits
 * and works before any JavaScript has loaded. `useActionState` upgrades it in
 * place once hydrated -- validation messages render without a full navigation --
 * but nothing here depends on that happening.
 *
 * `next` rides along as a hidden input rather than being read from the URL inside
 * the action, because a Server Action has no request URL of its own.
 */
export function SignInForm({ next, disabled }: { next: string; disabled?: boolean }) {
  const [state, action] = useActionState(signInAction, emptyAuthState)

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />

      {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

      <Field id="email" label="Email address" error={state.fieldErrors?.email} required>
        {(field) => (
          <Input
            {...field}
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email}
            disabled={disabled}
            autoFocus
          />
        )}
      </Field>

      <Field id="password" label="Password" error={state.fieldErrors?.password} required>
        {(field) => (
          <Input
            {...field}
            name="password"
            type="password"
            autoComplete="current-password"
            disabled={disabled}
          />
        )}
      </Field>

      <SubmitButton variant="primary" block pendingLabel="Signing in…" disabled={disabled}>
        Sign in
      </SubmitButton>
    </form>
  )
}
