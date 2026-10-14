'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { updateProfileAction } from '@/features/profiles/actions'
import { emptyProfileState } from '@/features/profiles/form-state'
import type { FullProfile, UniversityOption } from '@/features/profiles/queries'

/**
 * Profile editing.
 *
 * Username is not here. The database rate-limits a change to once per 30 days, and
 * a field with that consequence does not belong next to "bio" where it can be
 * edited in passing -- it needs its own form saying what will break. Until that
 * form exists, the handle is fixed after onboarding and the page says so.
 *
 * `visibility` is a real control, not decoration: the value chosen here is what the
 * RLS policies read, and it also caps how visible any project this person owns can
 * be. That relationship is explained rather than left as a surprise.
 */
export function ProfileEditForm({
  profile,
  universities,
}: {
  profile: FullProfile
  universities: UniversityOption[]
}) {
  const [state, action] = useActionState(updateProfileAction, emptyProfileState)
  const value = (key: string, fallback: string | number | null) =>
    state.values?.[key] ?? (fallback === null ? '' : String(fallback))

  return (
    <form action={action} className="space-y-5" noValidate>
      {state.status === 'success' ? (
        <Alert tone="success">{state.message ?? 'Saved.'}</Alert>
      ) : null}
      {state.message && state.status === 'error' ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field id="displayName" label="Your name" error={state.fieldErrors?.displayName} required>
        {(field) => (
          <Input
            {...field}
            name="displayName"
            autoComplete="name"
            defaultValue={value('displayName', profile.display_name)}
          />
        )}
      </Field>

      <Field id="headline" label="Headline" error={state.fieldErrors?.headline}>
        {(field) => (
          <Input {...field} name="headline" defaultValue={value('headline', profile.headline)} />
        )}
      </Field>

      <Field
        id="bio"
        label="About you"
        hint="Up to 1000 characters."
        error={state.fieldErrors?.bio}
      >
        {(field) => (
          <Textarea {...field} name="bio" rows={5} defaultValue={value('bio', profile.bio)} />
        )}
      </Field>

      <div className="space-y-4 border-t border-hairline pt-5">
        <h2 className="text-sm font-medium text-ink">Where you study</h2>

        <Field id="universityId" label="University" error={state.fieldErrors?.universityId}>
          {(field) => (
            <Select
              {...field}
              name="universityId"
              defaultValue={value('universityId', profile.university_id)}
            >
              <option value="">Not saying</option>
              {universities.map((university) => (
                <option key={university.id} value={university.id}>
                  {university.name}
                  {university.country ? ` — ${university.country}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field id="degree" label="Degree or programme" error={state.fieldErrors?.degree}>
          {(field) => (
            <Input {...field} name="degree" defaultValue={value('degree', profile.degree)} />
          )}
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
                defaultValue={value('semester', profile.semester)}
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
                defaultValue={value('graduationYear', profile.graduation_year)}
              />
            )}
          </Field>
        </div>

        <Field id="location" label="Where you are" error={state.fieldErrors?.location}>
          {(field) => (
            <Input {...field} name="location" defaultValue={value('location', profile.location)} />
          )}
        </Field>
      </div>

      <div className="space-y-4 border-t border-hairline pt-5">
        <h2 className="text-sm font-medium text-ink">Links</h2>

        <Field
          id="website"
          label="Website"
          hint="Include https://"
          error={state.fieldErrors?.website}
        >
          {(field) => (
            <Input
              {...field}
              name="website"
              type="url"
              placeholder="https://"
              defaultValue={value('website', profile.website)}
            />
          )}
        </Field>

        <Field id="githubUsername" label="GitHub username" error={state.fieldErrors?.githubUsername}>
          {(field) => (
            <Input
              {...field}
              name="githubUsername"
              spellCheck={false}
              defaultValue={value('githubUsername', profile.github_username)}
            />
          )}
        </Field>
      </div>

      <div className="space-y-4 border-t border-hairline pt-5">
        <h2 className="text-sm font-medium text-ink">Who can see your profile</h2>

        <Field
          id="visibility"
          label="Profile visibility"
          hint="This is enforced in the database, not just in the interface. It also caps how visible any project you own can be — a project cannot be more public than its owner."
          error={state.fieldErrors?.visibility}
        >
          {(field) => (
            <Select
              {...field}
              name="visibility"
              defaultValue={value('visibility', profile.visibility)}
            >
              <option value="public">Anyone, including people who are not signed in</option>
              <option value="university">People at my university</option>
              <option value="connections">People I am connected to</option>
              <option value="private">Only me</option>
            </Select>
          )}
        </Field>
      </div>

      <div className="border-t border-hairline pt-5">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          Save changes
        </SubmitButton>
        <p className="mt-3 text-xs text-ink-muted">
          Your username is <strong className="font-medium text-ink">@{profile.username}</strong> and
          cannot be changed here yet — the database allows one change every 30 days, and the form for
          it is not built.
        </p>
      </div>
    </form>
  )
}
