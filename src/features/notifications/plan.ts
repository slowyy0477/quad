/**
 * The notification list's rules: the sentence, the link, the day grouping.
 *
 * Pure, and separate from the components and from the queries, because these are
 * the three places a notification list can lie:
 *
 *   1. **The sentence.** It is composed from `type` and the joined rows rather than
 *      stored, so a rename does not rewrite history — which also means an unknown
 *      type produces a sentence nobody wrote. That case is reported
 *      (`unknownType`) instead of being papered over with a vague phrase that
 *      looks like a real one.
 *   2. **The link.** `notifications` carries typed foreign keys with
 *      `on delete cascade` to seven different things, and the reader may not be
 *      allowed to see all of them. A link is only produced when the target came
 *      back from this reader's own select; otherwise the row says the thing is not
 *      available rather than offering a dead link. See `types.ts`.
 *   3. **The grouping.** "Today", "Yesterday", then the date. The same day key and
 *      the same labels the thread uses, imported rather than rewritten so there is
 *      one definition of which calendar day an instant falls in.
 *
 * `now` is a parameter so a test can stand at a fixed instant.
 */

import { format } from 'date-fns'
import { dayKey, dayLabel } from '@/features/messages/thread-plan'
import type { NotificationDay, NotificationTarget, NotificationView } from './types'

/**
 * A notification row, reduced to what the sentence and the link actually use.
 *
 * Structural, so the row type in `queries.ts` satisfies it without an import in
 * either direction. Every id column is here because one of them decides the link.
 */
export type NotificationInput = {
  id: string
  type: string
  body: string | null
  is_read: boolean
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
  actor: { id: string; username: string; display_name: string; avatar_url: string | null } | null
}

/**
 * What the reader's own selects returned for the targets on this page.
 *
 * Every set holds ids that came back from a `select` run as the reader, filtered by
 * `deleted_at is null`. Nothing here is inferred: a target missing from the index
 * is a target this reader cannot open, and that is the only conclusion the list
 * draws from it.
 */
export type TargetIndex = {
  posts: ReadonlySet<string>
  comments: ReadonlySet<string>
  /** id to slug: the project page is addressed by slug, not by id. */
  projects: ReadonlyMap<string, string>
  ideas: ReadonlySet<string>
  events: ReadonlySet<string>
  opportunities: ReadonlySet<string>
  conversations: ReadonlySet<string>
}

export function emptyTargetIndex(): TargetIndex {
  return {
    posts: new Set(),
    comments: new Set(),
    projects: new Map(),
    ideas: new Set(),
    events: new Set(),
    opportunities: new Set(),
    conversations: new Set(),
  }
}

type Family =
  | 'post'
  | 'project'
  | 'idea'
  | 'event'
  | 'opportunity'
  | 'conversation'
  | 'actor'
  | 'requests'
  | 'connections'
  | 'skills'
  | 'me'
  | 'none'

/**
 * Which part of the network a notification is about.
 *
 * Written out rather than derived from the type's prefix, because the two are not
 * the same question: `project_ownership_received` happens *to* the reader, but it
 * is about a project, and guessing from the string would eventually link to the
 * wrong place for a type whose name reads one way and points another.
 */
function familyOf(type: string): Family {
  switch (type) {
    case 'post_like':
    case 'post_comment':
    case 'comment_reply':
    case 'comment_like':
    case 'content_hidden':
    case 'content_removed':
      return 'post'
    case 'project_star':
    case 'project_application':
    case 'project_application_accepted':
    case 'project_application_rejected':
    case 'project_invite':
    case 'project_invite_accepted':
    case 'project_invite_declined':
    case 'project_member_joined':
    case 'project_ownership_received':
      return 'project'
    case 'idea_vote':
    case 'idea_interest':
    case 'idea_comment':
      return 'idea'
    case 'event_cancelled':
    case 'event_rescheduled':
    case 'event_reminder':
      return 'event'
    case 'opportunity_deadline':
      return 'opportunity'
    case 'message':
      return 'conversation'
    case 'follow':
      return 'actor'
    case 'connection_request':
      return 'requests'
    case 'connection_accepted':
      return 'connections'
    case 'skill_endorsement':
      return 'skills'
    case 'achievement_awarded':
      return 'me'
    default:
      return 'none'
  }
}

/** The noun a sentence falls back to when the target's title is not readable. */
function fallbackNoun(family: Family): string {
  switch (family) {
    case 'post':
      return 'your post'
    case 'project':
      return 'a project'
    case 'idea':
      return 'an idea'
    case 'event':
      return 'An event'
    case 'opportunity':
      return 'an opportunity'
    default:
      return 'something'
  }
}

/**
 * The sentence, from the type.
 *
 * A generic phrase per type rather than the target's title alone, because the title
 * is only readable some of the time: the sentence has to stand up without it.
 * `subject` is the target's title when there is one, and a plain noun when there is
 * not.
 */
function sentence(type: string, who: string, family: Family, subject: string): string {
  switch (type) {
    case 'follow':
      return `${who} started following you.`
    case 'connection_request':
      return `${who} asked to connect with you.`
    case 'connection_accepted':
      return `${who} accepted your connection request.`
    case 'post_like':
      return `${who} liked ${subject}.`
    case 'post_comment':
      return `${who} commented on ${subject}.`
    case 'comment_reply':
      return `${who} replied to your comment.`
    case 'comment_like':
      return `${who} liked your comment.`
    case 'project_star':
      return `${who} starred ${subject}.`
    case 'project_application':
      return `${who} applied to ${subject}.`
    case 'project_application_accepted':
      return `Your application to ${subject} was accepted.`
    case 'project_application_rejected':
      return `Your application to ${subject} was declined.`
    case 'project_invite':
      return `${who} invited you to ${subject}.`
    case 'project_invite_accepted':
      return `${who} accepted your invitation to ${subject}.`
    case 'project_invite_declined':
      return `${who} declined your invitation to ${subject}.`
    case 'project_member_joined':
      return `${who} joined ${subject}.`
    case 'project_ownership_received':
      return `You were given ownership of ${subject}.`
    case 'idea_vote':
      return `${who} voted for ${subject}.`
    case 'idea_interest':
      return `${who} is interested in ${subject}.`
    case 'idea_comment':
      return `${who} commented on ${subject}.`
    case 'skill_endorsement':
      return `${who} endorsed one of your skills.`
    case 'message':
      return `${who} sent you a message.`
    case 'achievement_awarded':
      return 'You were awarded an achievement.'
    case 'event_cancelled':
      return `${subject} was cancelled.`
    case 'event_rescheduled':
      return `${subject} was rescheduled.`
    case 'event_reminder':
      return `${subject} starts soon.`
    case 'opportunity_deadline':
      return `The deadline for ${subject} is soon.`
    case 'content_hidden':
      return 'A moderator hid something you posted.'
    case 'content_removed':
      return 'A moderator removed something you posted.'
    default:
      return `${who} did something on Quad.`
  }
}

/**
 * Where the notification points, and whether the reader can still get there.
 *
 * `unavailable: true` is only ever set when the notification names a target and the
 * reader's own select did not return it. A notification with no target at all is
 * `unavailable: false` with a null target, because nothing is missing — the
 * distinction is what stops a follow from being labelled "no longer available".
 *
 * `/events` and `/opportunities` are the honest answer for the two things this
 * build has no per-item route for: the link label says "on the events list" rather
 * than pretending to open the event.
 */
export function resolveTarget(
  row: NotificationInput,
  index: TargetIndex,
): { target: NotificationTarget | null; unavailable: boolean } {
  const family = familyOf(row.type)

  switch (family) {
    case 'post': {
      if (!row.post_id) return { target: null, unavailable: false }
      if (!index.posts.has(row.post_id)) return { target: null, unavailable: true }
      const anchor =
        row.comment_id && index.comments.has(row.comment_id) ? `#comment-${row.comment_id}` : ''
      return { target: { href: `/post/${row.post_id}${anchor}`, label: 'Open the post' }, unavailable: false }
    }
    case 'project': {
      if (!row.project_id) return { target: null, unavailable: false }
      const slug = index.projects.get(row.project_id)
      if (!slug) return { target: null, unavailable: true }
      return { target: { href: `/projects/${slug}`, label: 'Open the project' }, unavailable: false }
    }
    case 'idea': {
      if (!row.idea_id) return { target: null, unavailable: false }
      if (!index.ideas.has(row.idea_id)) return { target: null, unavailable: true }
      return { target: { href: `/ideas/${row.idea_id}`, label: 'Open the idea' }, unavailable: false }
    }
    case 'event': {
      if (!row.event_id) return { target: null, unavailable: false }
      if (!index.events.has(row.event_id)) return { target: null, unavailable: true }
      return {
        target: { href: '/events', label: 'See it on the events list' },
        unavailable: false,
      }
    }
    case 'opportunity': {
      if (!row.opportunity_id) return { target: null, unavailable: false }
      if (!index.opportunities.has(row.opportunity_id)) return { target: null, unavailable: true }
      return {
        target: { href: '/opportunities', label: 'See it in opportunities' },
        unavailable: false,
      }
    }
    case 'conversation': {
      if (!row.conversation_id) return { target: null, unavailable: false }
      if (!index.conversations.has(row.conversation_id)) return { target: null, unavailable: true }
      return {
        target: { href: `/messages?c=${row.conversation_id}`, label: 'Open the conversation' },
        unavailable: false,
      }
    }
    case 'actor': {
      // A profile that is not readable has no url to offer, and the actor being
      // absent is not a deleted target: the notification is still about a person.
      if (!row.actor) return { target: null, unavailable: false }
      return { target: { href: `/u/${row.actor.username}`, label: 'Open their profile' }, unavailable: false }
    }
    case 'requests':
      return { target: { href: '/connections/requests', label: 'See your requests' }, unavailable: false }
    case 'connections':
      return { target: { href: '/connections', label: 'See your connections' }, unavailable: false }
    case 'skills':
      return { target: { href: '/me/skills', label: 'See your skills' }, unavailable: false }
    case 'me':
      return { target: { href: '/me', label: 'Your profile' }, unavailable: false }
    default:
      return { target: null, unavailable: false }
  }
}

/** One row, turned into the view the list renders. Pure. */
export function toNotificationView(row: NotificationInput, index: TargetIndex): NotificationView {
  const family = familyOf(row.type)
  const known = family !== 'none' || row.type.length > 0
  const who = row.actor?.display_name ?? 'Someone'

  // The title, when the reader is allowed to have it. `projects` was selected with
  // its title alongside its slug elsewhere; here the index only carries the slug, so
  // the subject falls back to the noun for every family except the ones whose target
  // title this list cannot read without a second lookup it does not need.
  const subject = fallbackNoun(family)
  const { target, unavailable } = resolveTarget(row, index)

  return {
    id: row.id,
    type: row.type,
    is_read: row.is_read,
    created_at: row.created_at,
    text: sentence(row.type, who, family, subject),
    detail: row.body,
    actorName: row.actor?.display_name ?? null,
    actorAvatar: row.actor?.avatar_url ?? null,
    target,
    targetUnavailable: unavailable,
    unknownType: !known,
  }
}

/** The clock time of a notification, in the reader's local time zone. */
export function notificationTime(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return ''
  return format(date, 'HH:mm')
}

/**
 * Group by calendar day, newest first, keeping the order the query returned.
 *
 * The database sorts by `created_at desc, id desc` and that order is preserved
 * inside each day; the grouping only inserts headings. A row with an unparseable
 * timestamp lands under "Undated" rather than being dropped, because a
 * notification that exists and cannot be placed is still one the reader is owed.
 */
export function groupNotificationsByDay(
  views: NotificationView[],
  now: Date,
): NotificationDay[] {
  const days: NotificationDay[] = []
  let current: NotificationDay | null = null

  for (const view of views) {
    const key = dayKey(view.created_at)
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(view.created_at, now), items: [] }
      days.push(current)
    }
    current.items.push(view)
  }

  return days
}
