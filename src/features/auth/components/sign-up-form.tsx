'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/features/auth/components/password-input'
import { SubmitButton } from '@/components/ui/submit-button'
import { signUpAction } from '@/features/auth/actions'
import { emptyAuthState } from '@/features/auth/form-state'

/**
 * Sign-up form.
 *
 * Three fields and a checkbox. Not a username: the profile row is created by a
 * database trigger with a placeholder handle, and choosing a real one belongs in
 * onboarding where the "that's taken" round-trip can be handled without losing a
 * half-filled registration form.
 *
 * The password hint states the rule up front instead of waiting to reject the
 * submission. It is the same rule the server enforces.
 */
export function SignUpForm({ disabled }: { disabled?: boolean }) {
  const [state, action] = useActionState(signUpAction, emptyAuthState)

  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

      <Field
        id="displayName"
        label="Your name"
        hint="How you'll appear to other students. You can change it later."
        error={state.fieldErrors?.displayName}
        required
      >
        {(field) => (
          <Input
            {...field}
            name="displayName"
            autoComplete="name"
            defaultValue={state.values?.displayName}
            disabled={disabled}

          />
        )}
      </Field>

      <Field
        id="email"
        label="Email address"
        hint="Use an email you can access. It won't be shown on your profile."
        error={state.fieldErrors?.email}
        required
      >
        {(field) => (
          <Input
            {...field}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={state.values?.email}
            disabled={disabled}
          />
        )}
      </Field>

      <Field
        id="password"
        label="Password"
        hint="At least 15 characters. A short phrase is easier to remember and harder to guess."
        error={state.fieldErrors?.password}
        required
      >
        {(field) => (
          <PasswordInput
            {...field}
            name="password"
            autoComplete="new-password"
            disabled={disabled}
          />
        )}
      </Field>

      <div className="space-y-1.5">
        <label className="flex min-h-11 items-start gap-3 py-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            name="acceptTerms"
            className="mt-0.5 size-5 shrink-0 rounded-xs border-rule accent-accent-600"
            aria-invalid={state.fieldErrors?.acceptTerms ? true : undefined}
            aria-describedby={state.fieldErrors?.acceptTerms ? 'acceptTerms-error' : undefined}
            disabled={disabled}
          />
          <span>
            I agree to the{' '}
            <Link href="/terms" className="text-accent-700 underline underline-offset-2">
              terms of use
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-accent-700 underline underline-offset-2">
              privacy notice
            </Link>
            .
          </span>
        </label>
        {state.fieldErrors?.acceptTerms ? (
          <p id="acceptTerms-error" role="alert" className="text-xs font-medium text-danger-600">
            {state.fieldErrors.acceptTerms}
          </p>
        ) : null}
      </div>

      <SubmitButton variant="primary" block pendingLabel="Creating your account…" disabled={disabled}>
        Create account
      </SubmitButton>
    </form>
  )
}
