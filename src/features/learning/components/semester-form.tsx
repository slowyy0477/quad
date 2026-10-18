'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { SEMESTER_TERMS } from '@/features/learning/constants'
import { createSemesterAction } from '@/features/learning/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * A term, added.
 *
 * `is_current` is not a field here. The database demotes the previous current term in the
 * same statement that sets the new one, and the partial unique index makes two current
 * terms impossible — so "make this current" is a separate, reversible action on a term that
 * exists, not a checkbox on a create form that would have to lie about ordering.
 */
export function SemesterForm() {
  const [state, action] = useActionState(createSemesterAction, emptyFormState)
  const year = new Date().getFullYear()

  return (
    <form action={action} className="space-y-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The term was not added">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? (
        <Alert tone="success">{state.message}</Alert>
      ) : null}

      <Field
        id="semester-name"
        label="Name"
        required
        hint="How you will recognise it in a list — “Autumn 2026”, “Semester 1”."
        error={state.fieldErrors?.name}
      >
        {(props) => (
          <Input
            {...props}
            name="name"
            maxLength={80}
            defaultValue={state.values?.name ?? ''}
            placeholder="Autumn 2026"
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="semester-term" label="Term" error={state.fieldErrors?.term}>
          {(props) => (
            <Select {...props} name="term" defaultValue={state.values?.term ?? ''}>
              <option value="">Not set</option>
              {SEMESTER_TERMS.map((term) => (
                <option key={term.value} value={term.value}>
                  {term.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field id="semester-year" label="Year" error={state.fieldErrors?.year}>
          {(props) => (
            <Input
              {...props}
              name="year"
              type="number"
              min="1950"
              max="2100"
              defaultValue={state.values?.year ?? String(year)}
            />
          )}
        </Field>

        <Field id="semester-start" label="Starts" error={state.fieldErrors?.startDate}>
          {(props) => (
            <Input {...props} name="startDate" type="date" defaultValue={state.values?.startDate ?? ''} />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="semester-end"
          label="Ends"
          hint="Optional. Cannot be before the start."
          error={state.fieldErrors?.endDate}
        >
          {(props) => (
            <Input {...props} name="endDate" type="date" defaultValue={state.values?.endDate ?? ''} />
          )}
        </Field>
      </div>

      <SubmitButton pendingLabel="Adding…">Add the term</SubmitButton>
    </form>
  )
}
