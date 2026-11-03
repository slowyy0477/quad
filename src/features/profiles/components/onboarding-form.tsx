'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { useRetainedForm } from '@/components/ui/use-retained-form'
import { completeOnboardingAction } from '@/features/profiles/actions'
import { emptyProfileState } from '@/features/profiles/form-state'
import type { UniversityOption } from '@/features/profiles/queries'
import { UniversityDepartmentFields } from './university-department-fields'

/**
 * Onboarding.
 *
 * One screen, not a wizard. A multi-step flow would need to hold partial state
 * somewhere between steps, and the only field here that can actually fail on the
 * server is the username -- so a wizard would mean either re-validating at the end
 * anyway or losing what was typed.
 *
 * Identity and the publication choice are required. Campus details are genuinely
 * optional. Publication starts at private, not an already-selected public option.
 */
export function OnboardingForm({
  universities,
  defaultDisplayName,
  suggestedUsername,
}: {
  universities: UniversityOption[]
  defaultDisplayName: string
  suggestedUsername: string
}) {
  const [state, action] = useActionState(completeOnboardingAction, emptyProfileState)
  const formRef = useRetainedForm()

  return (
    <form ref={formRef} action={action} className="space-y-5" noValidate>
      {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

      <Field
        id="username"
        label="Choose a username"
        hint="Letters, numbers and underscores. Your Bulla profile will be at /u/yourname."
        error={state.fieldErrors?.username}
        required
      >
        {(field) => (
          <Input
            {...field}
            name="username"
            autoComplete="username"
            spellCheck={false}
            defaultValue={state.values?.username ?? suggestedUsername}
            autoFocus
          />
        )}
      </Field>

      <Field
        id="displayName"
        label="Your name"
        error={state.fieldErrors?.displayName}
        required
      >
        {(field) => (
          <Input
            {...field}
            name="displayName"
            autoComplete="name"
            defaultValue={state.values?.displayName ?? defaultDisplayName}
          />
        )}
      </Field>

      <Field
        id="headline"
        label="Headline"
        hint="One line under your name. “Second-year CS, into embedded systems.”"
        error={state.fieldErrors?.headline}
      >
        {(field) => (
          <Input {...field} name="headline" defaultValue={state.values?.headline} />
        )}
      </Field>

      <div className="border-t border-hairline pt-5">
        <h2 className="text-sm font-medium text-ink">Where you study</h2>
        <p className="mt-1 text-xs text-ink-muted">
          All optional. Leave it blank if you would rather not say.
        </p>

        <div className="mt-4 space-y-4">
          <UniversityDepartmentFields universities={universities} state={state} />

          <Field
            id="degree"
            label="Degree or programme"
            hint="Free text, because programme names differ everywhere. “BSc Computer Science”."
            error={state.fieldErrors?.degree}
          >
            {(field) => <Input {...field} name="degree" defaultValue={state.values?.degree} />}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="semester" label="Current semester" error={state.fieldErrors?.semester}>
              {(field) => (
                <Input
                  {...field}
                  name="semester"
                  type="number"
                  min={1}
                  max={24}
                  inputMode="numeric"
                  defaultValue={state.values?.semester}
                />
              )}
            </Field>

            <Field
              id="graduationYear"
              label="Expected graduation"
              error={state.fieldErrors?.graduationYear}
            >
              {(field) => (
                <Input
                  {...field}
                  name="graduationYear"
                  type="number"
                  min={1950}
                  max={2100}
                  inputMode="numeric"
                  placeholder="2028"
                  defaultValue={state.values?.graduationYear}
                />
              )}
            </Field>
          </div>
        </div>
      </div>

      <div className="border-t border-hairline pt-5">
        <Field
          id="bio"
          label="About you"
          hint="What you are working on, what you want to learn, what you would help with."
          error={state.fieldErrors?.bio}
        >
          {(field) => <Textarea {...field} name="bio" rows={5} defaultValue={state.values?.bio} />}
        </Field>
      </div>

      <div className="border-t border-hairline pt-5">
        <Field
          id="visibility"
          label="Who can see your profile?"
          hint="Private keeps your profile visible only to you. Choose a wider audience only when you want to publish it. You can change this later."
          error={state.fieldErrors?.visibility}
          required
        >
          {(field) => (
            <Select {...field} name="visibility" defaultValue={state.values?.visibility ?? 'private'}>
              <option value="private">Private — only me</option>
              <option value="connections">My accepted connections</option>
              <option value="university">People at my university</option>
              <option value="public">Public — everyone, including signed-out visitors</option>
            </Select>
          )}
        </Field>
        <p className="mt-2 text-xs text-ink-muted">
          Your university and department are self-declared, not verified. This choice does not change your separate
          people-search, messaging or connection-request preferences.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          Finish and go to my profile
        </SubmitButton>
        <p className="text-xs text-ink-muted">
          You can change any of this later from{' '}
          <Link href="/me/edit" className="text-accent-700 underline underline-offset-2">
            your profile
          </Link>
          .
        </p>
      </div>
    </form>
  )
}
