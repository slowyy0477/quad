'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { triageBugReportAction } from '@/features/bugs/actions'
import { emptyBugTriageFormState } from '@/features/bugs/form-state'
import { BUG_STATUSES, BUG_STATUS_LABEL, type BugStatus } from '@/features/bugs/schemas'

/**
 * Triage: one select and one button per report.
 *
 * An inline control rather than a dialog, because unlike hiding somebody's post
 * this is neither destructive nor irreversible — a status can be set again — and a
 * confirmation on every change trains the reader to click through confirmations,
 * which is the habit that makes the moderation dialogs worthless.
 *
 * Rendered only on the administrator's list. What keeps it that way is
 * `bug_reports_update_admin` plus `grant update (status)` in 0020: a moderator who
 * reached this markup another way would find the write refused.
 */
export function BugTriageForm({ bugId, status }: { bugId: string; status: BugStatus }) {
  const [state, send] = useActionState(triageBugReportAction, emptyBugTriageFormState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset()
  }, [state])

  return (
    <form ref={formRef} action={send} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="bugId" value={bugId} />

      <Field
        id={`bug-status-${bugId}`}
        label="Status"
        className="w-44"
        error={state.fieldErrors?.status}
      >
        {(fieldProps) => (
          <Select {...fieldProps} name="status" defaultValue={status}>
            {BUG_STATUSES.map((value) => (
              <option key={value} value={value}>
                {BUG_STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
        Save
      </SubmitButton>

      {state.status === 'error' ? (
        <Alert tone="danger" className="w-full">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' ? (
        <span role="status" className="text-xs text-ink-muted">
          {state.message}
        </span>
      ) : null}
    </form>
  )
}
