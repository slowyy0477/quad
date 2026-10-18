'use client'

import { useActionState } from 'react'
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
import { Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { decideReportAction } from '@/features/moderation/actions'
import { emptyModerationState } from '@/features/moderation/form-state'
import type { ModerationAction } from '@/features/moderation/schemas'

/**
 * The decision controls on a queue row.
 *
 * One dialog per action, each naming its object. UX.md §5 is specific about this
 * and it is worth following to the letter: "Hide" as a bare button next to
 * "Remove" is a coin toss under a thumb, and the object's name in the title is
 * what makes the difference legible at the moment of clicking.
 *
 * Every dialog requires a reason and every dialog says *who is affected*. The
 * reason is not decoration: moderation_actions cannot be written without one
 * (0020), so an empty reason is a refused write rather than a blank field in a
 * log.
 *
 * The confirmation button carries the verb ("Hide", "Suspend Sophia") and the
 * safe action is the first thing in the tab order after the fields.
 */

type Spec = {
  action: ModerationAction
  /** The button that opens it. */
  verb: string
  /** The confirmation button's label. */
  confirm: string
  title: (context: { subject: string; reported: string }) => string
  /** What this actually does, in the order a moderator needs to know it. */
  body: (context: { subject: string; reported: string; reason: string }) => string
  tone: 'danger' | 'secondary'
}

const CONTENT_ACTIONS: Spec[] = [
  {
    action: 'hide_content',
    verb: 'Hide',
    confirm: 'Hide',
    title: ({ subject }) => `Hide ${subject}?`,
    body: ({ subject, reported, reason }) =>
      `${subject} by ${reported} stops being shown to anyone else. Its author and other moderators ` +
      `still see it where it was, and the author is told it was hidden. Reported for “${reason}”.`,
    tone: 'danger',
  },
  {
    action: 'remove_content',
    verb: 'Remove',
    confirm: 'Remove',
    title: ({ subject }) => `Remove ${subject}?`,
    body: ({ subject, reported, reason }) =>
      `${subject} by ${reported} stops being shown to anyone else, and the author is told it was ` +
      `removed. Their own view of it stays — posts_select keeps an author’s own row visible — and ` +
      `the row stays in the database as evidence. Reported for “${reason}”.`,
    tone: 'danger',
  },
  {
    action: 'restore_content',
    verb: 'Restore',
    confirm: 'Restore',
    title: ({ subject }) => `Restore ${subject}?`,
    body: ({ subject }) => `${subject} becomes visible again under the same rules as before.`,
    tone: 'secondary',
  },
  {
    action: 'warn_user',
    verb: 'Warn',
    confirm: 'Warn',
    title: ({ reported }) => `Warn ${reported}?`,
    body: ({ reported, reason }) =>
      `Records a warning on ${reported}’s account and changes nothing else — nothing is hidden and ` +
      `nothing is blocked. Reported for “${reason}”.`,
    tone: 'secondary',
  },
  {
    action: 'suspend_user',
    verb: 'Suspend',
    confirm: 'Suspend',
    title: ({ reported }) => `Suspend ${reported}?`,
    body: ({ reported, reason }) =>
      `${reported} can still sign in and read, but cannot post, comment, send a message or start an ` +
      `idea until the period you choose ends. Creating a project is not blocked yet — that trigger ` +
      `is outstanding work. Reported for “${reason}”.`,
    tone: 'danger',
  },
  {
    action: 'dismiss_report',
    verb: 'Dismiss',
    confirm: 'Dismiss report',
    title: () => 'Dismiss this report?',
    body: () =>
      'Nothing is hidden and no account is changed. The reporter is told their report was reviewed ' +
      'and no action was taken.',
    tone: 'secondary',
  },
]

/** A report about a person offers no content actions — there is no content. */
const PROFILE_ACTIONS: Spec[] = CONTENT_ACTIONS.filter(
  (spec) => spec.action === 'warn_user' || spec.action === 'suspend_user' || spec.action === 'dismiss_report',
)

export function ReportDecisionActions({
  reportId,
  subject,
  reportedName,
  reason,
  hasContent,
}: {
  reportId: string
  /** "this post", "this message", "this account". */
  subject: string
  /** The person answerable, as a display name. */
  reportedName: string
  /** The reason the reporter picked, quoted back in the dialog. */
  reason: string
  /** False for a profile report: hiding a person is not a thing. */
  hasContent: boolean
}) {
  const specs = hasContent ? CONTENT_ACTIONS : PROFILE_ACTIONS

  return (
    <div className="flex flex-wrap gap-2">
      {specs.map((spec) => (
        <DecisionDialog
          key={spec.action}
          spec={spec}
          reportId={reportId}
          context={{ subject, reported: reportedName, reason }}
        />
      ))}
    </div>
  )
}

function DecisionDialog({
  spec,
  reportId,
  context,
}: {
  spec: Spec
  reportId: string
  context: { subject: string; reported: string; reason: string }
}) {
  const [state, send] = useActionState(decideReportAction, emptyModerationState)

  /*
   * A successful decision replaces the form with a confirmation rather than
   * closing the dialog. Two reasons, and the second is the one that decided it:
   * the moderator gets an explicit "recorded" for an action they cannot undo, and
   * an effect that called `setOpen(false)` on success is the pattern the lint rule
   * react-hooks/set-state-in-effect refuses — correctly, because a dialog closing
   * itself as a side effect of a state change is a cascading render. The
   * confirmation panel needs no effect at all.
   *
   * The row this dialog belongs to disappears with the confirmation, because the
   * action revalidates /admin.
   */
  const done = state.status === 'success'

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={spec.tone === 'danger' ? 'danger' : 'secondary'} size="sm">
          {spec.verb}
        </Button>
      </DialogTrigger>

      <DialogContent title={spec.title(context)} description={spec.body(context)}>
        {done ? (
          <div className="space-y-4">
            <Alert tone="success" title="Recorded">
              {state.message}
            </Alert>
            <p className="text-sm text-ink-muted">
              The decision is in the audit log with your name and the reason you gave, and it cannot
              be edited or deleted afterwards.
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form action={send} className="space-y-5">
            {state.status === 'error' ? <Alert tone="danger">{state.message}</Alert> : null}

          <input type="hidden" name="reportId" value={reportId} />
          <input type="hidden" name="action" value={spec.action} />

          {spec.action === 'suspend_user' ? (
            <Field
              id={`suspend-days-${reportId}`}
              label="Suspend for"
              hint="Counting from now. The database decides this, and an expired suspension stops on its own."
            >
              {(fieldProps) => (
                <Select {...fieldProps} name="days" defaultValue="7">
                  <option value="1">1 day</option>
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </Select>
              )}
            </Field>
          ) : null}

          <Field
            id={`reason-${reportId}`}
            label="Reason"
            hint="Kept in the audit log, where every moderator can read it. The person affected is not shown this."
            error={state.fieldErrors?.reason}
            required
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                name="reason"
                rows={3}
                maxLength={1000}
                placeholder="What did you find, and why is this the right action?"
              />
            )}
          </Field>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton
              variant={spec.tone === 'danger' ? 'danger' : 'primary'}
              pendingLabel="Recording…"
            >
              {spec.confirm}
            </SubmitButton>
          </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
