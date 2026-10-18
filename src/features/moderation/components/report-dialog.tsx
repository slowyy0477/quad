'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { RadioGroup, RadioOption } from '@/components/ui/radio-group'
import { SubmitButton } from '@/components/ui/submit-button'
import { submitReportAction } from '@/features/moderation/actions'
import { emptyReportState } from '@/features/moderation/form-state'
import { REPORT_REASONS, type ReportKind } from '@/features/moderation/schemas'

/**
 * The report dialog — UX.md §4, the M7 safety surface.
 *
 * Built as a component rather than as a page because the entry point is "any
 * post, comment, profile or message", and the whole point of one dialog is that
 * the twelve places that need it produce the same thing. It takes the kind and the
 * id of what is being reported, so a caller cannot pass a label that disagrees
 * with the target.
 *
 * Two decisions in the copy, both deliberate:
 *
 *   * **The reporter is named to nobody.** "The person you are reporting is not
 *     told who reported them" is true in this system — the notification the author
 *     receives says their content was hidden, with a null actor (0014) — and it is
 *     the difference between someone reporting a classmate and someone deciding
 *     not to.
 *   * **It says what happens next, and the database keeps that promise.**
 *     moderation_actions records the decision and 0020 notifies the reporter when
 *     it is made. Copy that promises a process nobody runs is the failure mode
 *     PRODUCT.md rule 2 names.
 *
 * The confirmation replaces the form rather than closing the dialog immediately:
 * a report that vanishes on submit leaves the reporter unsure it happened, and
 * this is the one interaction where "did that work?" matters most.
 *
 * HOW TO MOUNT IT (for the feed, profiles, projects and messaging workstreams —
 * none of which this workstream may edit):
 *
 *   <ReportDialog kind="post" targetId={post.id} subject="this post"
 *     trigger={<Button variant="ghost" size="sm">Report</Button>} />
 *
 * The `kind` and the `targetId` are the whole contract: the action maps the kind
 * to the right target column (REPORT_TARGET_COLUMN), and a caller cannot pass a
 * label that disagrees with what is being reported. Expect the dialog to refuse
 * with "You can only report something you can see" if the reader cannot read the
 * row — that is the guard, not a bug.
 */
export function ReportDialog({
  kind,
  targetId,
  subject,
  trigger,
}: {
  /** What is being reported. */
  kind: ReportKind
  /** Its id. The action maps this to the right column. */
  targetId: string
  /** What to call it in the heading: "this post", "this person". */
  subject: string
  /** The element that opens the dialog. Rendered as the trigger. */
  trigger: React.ReactNode
}) {
  const [state, send] = useActionState(submitReportAction, emptyReportState)
  const formRef = useRef<HTMLFormElement>(null)

  // A success clears the reason and detail so a second report from the same
  // dialog (on a list of posts) does not silently resend the first one's text.
  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset()
  }, [state])

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent
        title={`Report ${subject}`}
        description="A moderator will look at this. The person you are reporting is not told who reported them."
      >
        {state.status === 'success' ? (
          <div className="space-y-4">
            <Alert tone="success" title="Report received">
              {state.message}
            </Alert>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form ref={formRef} action={send} className="space-y-5">
            {state.message && state.status === 'error' && !state.fieldErrors ? (
              <Alert tone="danger">{state.message}</Alert>
            ) : null}

            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="targetId" value={targetId} />

            <Field id="report-reason" label="Why are you reporting this?" error={state.fieldErrors?.reason} required>
              {(fieldProps) => (
                <RadioGroup name="reason" required aria-describedby={fieldProps['aria-describedby']}>
                  {REPORT_REASONS.map((reason, index) => (
                    <RadioOption
                      key={reason}
                      value={reason}
                      id={`report-reason-${index}`}
                      label={reason}
                    />
                  ))}
                </RadioGroup>
              )}
            </Field>

            <Field
              id="report-detail"
              label="Anything else a moderator should know?"
              hint="Optional. Do not repeat what is in the content — say what it does not show."
              error={state.fieldErrors?.detail}
            >
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  name="detail"
                  rows={4}
                  maxLength={2000}
                  placeholder="What happened, and what should a moderator look at?"
                />
              )}
            </Field>

            <p className="text-xs text-ink-muted">
              You will be told when a moderator decides. Reports are reviewed by a person, not
              automatically.
            </p>

            <DialogFooter>
              {/* The safe action first, and focused first: Radix focuses the first
                  focusable element in the content, which is the first radio. */}
              <DialogClose asChild>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </DialogClose>
              <SubmitButton variant="primary" pendingLabel="Sending…">
                Send report
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
