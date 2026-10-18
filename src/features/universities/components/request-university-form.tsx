'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { requestUniversityAction } from '@/features/universities/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Filing an institution that is not in the directory.
 *
 * Fields are wired through `Field`, so the label, the hint and the error are tied
 * to the control rather than merely placed near it. Nothing here can set the
 * status of what it files: the form sends a name and where it is, and the
 * before-insert trigger pins the row to `pending` with the submitter stamped from
 * the session.
 *
 * `defaultName` carries whatever was typed into the search box when nothing
 * matched, so the common path — search for your university, do not find it, file
 * it — does not ask for the same string twice.
 */
export function RequestUniversityForm({ defaultName = '' }: { defaultName?: string }) {
  const [state, action] = useActionState(requestUniversityAction, emptyFormState)

  return (
    <form action={action} className="space-y-4" noValidate>
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="Not filed">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? (
        <Alert tone="success" title="Filed">
          {state.message}
        </Alert>
      ) : null}

      <Field
        id="university-name"
        label="Institution name"
        hint="Say what it calls itself, in full. “COMSATS University Islamabad”, not “COMSATS”."
        error={state.fieldErrors?.name}
        required
      >
        {(field) => (
          <Input
            {...field}
            name="name"
            defaultValue={state.values?.name ?? defaultName}
            spellCheck={false}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="university-short-name"
          label="Short name"
          hint="How people abbreviate it. “NUST”."
          error={state.fieldErrors?.shortName}
        >
          {(field) => (
            <Input {...field} name="shortName" defaultValue={state.values?.shortName} />
          )}
        </Field>

        <Field id="university-city" label="City" error={state.fieldErrors?.city}>
          {(field) => <Input {...field} name="city" defaultValue={state.values?.city} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="university-country" label="Country" error={state.fieldErrors?.country}>
          {(field) => (
            <Input {...field} name="country" defaultValue={state.values?.country} />
          )}
        </Field>

        <Field
          id="university-website"
          label="Website"
          hint="Optional. Start it with https://."
          error={state.fieldErrors?.website}
        >
          {(field) => (
            <Input
              {...field}
              name="website"
              type="url"
              inputMode="url"
              defaultValue={state.values?.website}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel="Filing…">
          File for review
        </SubmitButton>
        <p className="text-xs text-ink-muted">
          A moderator decides; it is not automatic, and it is not instant.
        </p>
      </div>
    </form>
  )
}
