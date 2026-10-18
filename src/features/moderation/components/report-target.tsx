import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import type { PersonRef, ReportTarget } from '@/features/moderation/queries'

/**
 * The reported thing, rendered inline in the queue.
 *
 * A moderator cannot decide from a reason string alone: "Harassment or bullying"
 * attached to a two-word reply and to a four-paragraph post are different
 * decisions. So the content is on the screen, in the queue, without a second tab.
 *
 * Every branch is rendered as *text*, never as HTML: a reported post is untrusted
 * input, and `dangerouslySetInnerHTML` on it would make the moderation queue the
 * most valuable XSS target in the application.
 *
 * A message gets an explicit banner saying it is private and why it is visible.
 * The narrow read in 0020 is a deliberate exception to "nobody reads private
 * messages", and an exception that isn't labelled on screen is one that gets
 * relied on absent-mindedly.
 */

const DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})

function when(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'an unknown time' : `${DATE.format(parsed)} UTC`
}

function Person({ person }: { person: PersonRef | null }) {
  if (!person) return <span className="text-ink-faint">a deleted account</span>
  return (
    <Link
      href={`/u/${person.username}`}
      className="rounded text-accent-700 underline underline-offset-2"
    >
      {person.displayName}
    </Link>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return null
  return (
    <Badge tone={status === 'removed' ? 'danger' : 'highlight'}>
      {status === 'removed' ? 'Already removed' : 'Already hidden'}
    </Badge>
  )
}

export function ReportTargetPreview({ target }: { target: ReportTarget }) {
  if (target.kind === 'post') {
    return (
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Person person={target.author} />
          <span>· posted {when(target.createdAt)}</span>
          <StatusBadge status={target.moderationStatus} />
        </p>
        <p className="max-h-64 overflow-y-auto border-l-2 border-rule pl-3 text-sm whitespace-pre-wrap text-ink">
          {target.body ?? '(This post has no text — it may be a link or an image only.)'}
        </p>
      </div>
    )
  }

  if (target.kind === 'comment') {
    return (
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Person person={target.author} />
          <span>· commented {when(target.createdAt)}</span>
          <StatusBadge status={target.moderationStatus} />
        </p>
        <p className="max-h-64 overflow-y-auto border-l-2 border-rule pl-3 text-sm whitespace-pre-wrap text-ink">
          {target.body ?? '(This comment has no text.)'}
        </p>
      </div>
    )
  }

  if (target.kind === 'project') {
    return (
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          Project · <Person person={target.author} />
          <StatusBadge status={target.moderationStatus} />
        </p>
        <p className="text-sm font-medium text-ink">{target.title}</p>
        {target.tagline ? <p className="text-sm text-ink-muted">{target.tagline}</p> : null}
        <Link
          href={`/projects/${target.slug}`}
          className="rounded text-xs text-accent-700 underline underline-offset-2"
        >
          Open the project page
        </Link>
      </div>
    )
  }

  if (target.kind === 'idea') {
    return (
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          Idea · <Person person={target.author} />
          <StatusBadge status={target.moderationStatus} />
        </p>
        <p className="text-sm font-medium text-ink">{target.title}</p>
        <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-ink-muted">
          {target.description}
        </p>
      </div>
    )
  }

  if (target.kind === 'message') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-ink-muted">Private message · sent {when(target.createdAt)}</p>
        <Surface className="bg-paper-sunken p-3">
          <p className="text-xs text-ink-faint">
            This is a private message. It is visible to you only because somebody reported it, and
            no other message in the conversation is.
          </p>
          <p className="mt-2 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap text-ink">
            {target.body ?? '(This message has no text — it may be an attachment only.)'}
          </p>
        </Surface>
        <StatusBadge status={target.moderationStatus} />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-muted">A person · their profile was reported</p>
      <p className="text-sm text-ink">
        <Person person={target.person} />
      </p>
    </div>
  )
}
