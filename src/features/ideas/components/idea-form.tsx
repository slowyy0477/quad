'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { CATEGORIES, IDEA_STATUSES, VISIBILITIES } from '@/features/projects/constants'
import { createIdeaAction, updateIdeaAction } from '@/features/ideas/actions'
import { emptyFormState } from '@/lib/form-state'

export type IdeaFormValues = {
  id?: string
  title?: string
  description?: string
  category?: string
  lookingFor?: string | null
  status?: string
  visibility?: string
}

/**
 * Write an idea, or edit one you wrote.
 *
 * One component for both, because the fields are the same and the only differences are
 * which action runs and whether `status` is offered. `status` is absent from the create
 * form on purpose: the insert trigger forces a new idea to `open`, and a dropdown that
 * cannot be honoured is a control that lies.
 *
 * `converted` is never an option in the edit form either. An idea becomes a project
 * through the conversion control, and the trigger refuses a direct change to
 * `converted_project_id`, so offering the state here would only produce a refusal.
 */
export function IdeaForm({ mode, idea }: { mode: 'create' | 'edit'; idea?: IdeaFormValues }) {
  const [state, action] = useActionState(
    mode === 'create' ? createIdeaAction : updateIdeaAction,
    emptyFormState,
  )

  return (
    <form action={action} className="space-y-5">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title={mode === 'create' ? 'The idea was not posted' : 'Not saved'}>
          {state.message}
        </Alert>
      ) : null}

      {mode === 'edit' && idea?.id ? <input type="hidden" name="ideaId" value={idea.id} /> : null}

      <Field id="idea-title" label="Title" required hint="A short name for the idea." error={state.fieldErrors?.title}>
        {(props) => (
          <Input
            {...props}
            name="title"
            defaultValue={state.values?.title ?? idea?.title ?? ''}
            maxLength={140}
            placeholder="A shared timetable for lab groups"
          />
        )}
      </Field>

      <Field
        id="idea-description"
        label="The pitch"
        required
        hint="At least 20 characters. What it is, and why it is worth building."
        error={state.fieldErrors?.description}
      >
        {(props) => (
          <Textarea
            {...props}
            name="description"
            rows={6}
            maxLength={5000}
            defaultValue={state.values?.description ?? idea?.description ?? ''}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="idea-category" label="Category" error={state.fieldErrors?.category}>
          {(props) => (
            <Select {...props} name="category" defaultValue={state.values?.category ?? idea?.category ?? 'other'}>
              {CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id="idea-visibility"
          label="Who can see it"
          hint="A private idea is visible to you alone, and it cannot be converted into a public project."
          error={state.fieldErrors?.visibility}
        >
          {(props) => (
            <Select
              {...props}
              name="visibility"
              defaultValue={state.values?.visibility ?? idea?.visibility ?? 'public'}
            >
              {VISIBILITIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {mode === 'edit' ? (
        <Field id="idea-status" label="Status" hint="“Became a project” is set by converting, not chosen here.">
          {(props) => (
            <Select {...props} name="status" defaultValue={idea?.status ?? 'open'}>
              {IDEA_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      <Field
        id="idea-looking-for"
        label="Who you are looking for"
        hint="Optional. The people, skills or point of view you need. Up to 1000 characters."
        error={state.fieldErrors?.lookingFor}
      >
        {(props) => (
          <Textarea
            {...props}
            name="lookingFor"
            rows={3}
            maxLength={1000}
            defaultValue={state.values?.lookingFor ?? idea?.lookingFor ?? ''}
          />
        )}
      </Field>

      <SubmitButton variant="primary" pendingLabel="Saving…">
        {mode === 'create' ? 'Post the idea' : 'Save changes'}
      </SubmitButton>
    </form>
  )
}
