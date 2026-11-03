'use client'

import { useState } from 'react'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import type { ProfileFormState } from '../form-state'
import type { UniversityOption } from '../queries'

// This is a UI-only option, never an ID sent to a Server Action.
const KEEP_EXISTING = 'keep-existing-department'

/** Campus and department are separate, optional, self-declared selections. */
export function UniversityDepartmentFields({
  universities,
  state,
  currentUniversityId = null,
  currentUniversityName = null,
  currentDepartmentId = null,
  currentDepartmentName = null,
  legacyDepartment = null,
}: {
  universities: UniversityOption[]
  state: ProfileFormState
  currentUniversityId?: string | null
  currentUniversityName?: string | null
  currentDepartmentId?: string | null
  currentDepartmentName?: string | null
  legacyDepartment?: string | null
}) {
  const currentOptions = universities.find((row) => row.id === currentUniversityId)?.departments ?? []
  const preserveExisting = Boolean(legacyDepartment ||
    (currentDepartmentId && !currentOptions.some((row) =>
      row.id === currentDepartmentId && row.university_id === currentUniversityId)))
  const [selection, setSelection] = useState(() => ({
    universityId: state.values?.universityId?.trim() ?? currentUniversityId ?? '',
    departmentId: state.values?.departmentId?.trim() ??
      (preserveExisting ? KEEP_EXISTING : currentDepartmentId ?? ''),
  }))
  const [notice, setNotice] = useState('')
  const university = universities.find((row) => row.id === selection.universityId)
  const departments = (university?.departments ?? [])
    .filter((row) => row.university_id === selection.universityId)
  const canKeep = preserveExisting && selection.universityId === (currentUniversityId ?? '')
  const unlistedChoice = selection.departmentId !== '' && selection.departmentId !== KEEP_EXISTING &&
    !departments.some((row) => row.id === selection.departmentId)

  return (
    <div className="space-y-4">
      <Field
        id="universityId"
        label="University"
        error={state.fieldErrors?.universityId}
        hint={universities.length === 0
          ? 'No approved universities have been added to this deployment yet. You can leave this blank.'
          : 'Choose an approved directory reference. Your affiliation is self-declared, not verified.'}
      >
        {(field) => (
          <Select
            {...field}
            name="universityId"
            value={selection.universityId}
            onChange={(event) => {
              setSelection({ universityId: event.target.value, departmentId: '' })
              setNotice('University changed. The department selection was cleared. Choose one for this university or leave it blank, then save.')
            }}
          >
            <option value="">Not saying</option>
            {selection.universityId && !university ? (
              <option value={selection.universityId}>
                {currentUniversityName ?? 'Current university'} — not in the approved list
              </option>
            ) : null}
            {universities.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}{option.country ? ` — ${option.country}` : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        id="departmentId"
        label="Department"
        error={state.fieldErrors?.departmentId}
        hint={!selection.universityId
          ? 'Choose a university first, or leave your department blank. Degree text never selects a department.'
          : departments.length === 0
            ? 'No approved department references are listed for this university. You can leave this blank; your degree text stays separate.'
            : 'Optional and self-declared. These references belong to your university; choosing one does not verify your membership.'}
      >
        {(field) => (
          <Select
            {...field}
            // Keeping a text-only/unlisted legacy affiliation intentionally
            // omits the field. An empty option, in contrast, posts a clear.
            name={selection.departmentId === KEEP_EXISTING && canKeep ? undefined : 'departmentId'}
            value={selection.departmentId}
            onChange={(event) => {
              const departmentId = event.currentTarget.value
              setSelection((before) => ({ ...before, departmentId }))
              setNotice(departmentId === KEEP_EXISTING
                ? 'Your existing department will be kept unchanged.'
                : departmentId === ''
                  ? 'Your department will be cleared when you save.'
                  : 'Department selected for this university. Save to apply it.')
            }}
          >
            <option value="">Not saying / clear department</option>
            {canKeep ? (
              <option value={KEEP_EXISTING}>
                Keep existing — {legacyDepartment ?? currentDepartmentName ?? 'unlisted department'}
              </option>
            ) : null}
            {unlistedChoice ? (
              <option value={selection.departmentId} disabled>Selection no longer in the approved list</option>
            ) : null}
            {departments.map((department) => (
              <option key={department.id} value={department.id}>{department.name}</option>
            ))}
          </Select>
        )}
      </Field>
      {canKeep ? (
        <p className="text-xs text-ink-muted">
          Existing department text or an unlisted reference is not converted into a new directory
          selection. Keep it unchanged, choose an approved reference, or explicitly clear it.
        </p>
      ) : null}
      <p className="text-xs text-ink-muted">
        Changing or clearing a department also clears any linked programme selection. Your separate
        degree or programme text is not used to infer a department.
      </p>
      {notice ? <p role="status" className="text-xs text-ink-muted">{notice}</p> : null}
    </div>
  )
}
