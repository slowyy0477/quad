'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { requestPasswordResetAction } from '@/features/auth/actions'
import { emptyAuthState } from '@/features/auth/form-state'

export function ResetRequestForm({ disabled }: { disabled?: boolean }) {
  const [state, action] = useActionState(requestPasswordResetAction, emptyAuthState)

  return (
    <form action={action} className="space-y-4" noValidate>
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

      <SubmitButton variant="primary" block pendingLabel="Sending…" disabled={disabled}>
        Send reset link
      </SubmitButton>
    </form>
  )
}
