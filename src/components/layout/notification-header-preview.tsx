import 'server-only'

import Link from 'next/link'
import { unstable_rethrow } from 'next/navigation'
import {
  getNotifications,
  getTargetIndex,
  type NotificationRow as NotificationRecord,
} from '@/features/notifications/queries'
import { emptyTargetIndex, toNotificationView, type TargetIndex } from '@/features/notifications/plan'
import { NotificationRow } from '@/features/notifications/components/notification-row'
import type { NotificationView } from '@/features/notifications/types'

const PREVIEW_LIMIT = 5

export type NotificationHeaderPreviewModel =
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'ready'; views: NotificationView[]; linksResolved: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Validate fields actually consumed by links/forms; discard bodies and extras. */
function sanitizedRow(value: unknown): NotificationRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 ||
    typeof value.type !== 'string' || typeof value.is_read !== 'boolean' ||
    typeof value.created_at !== 'string' ||
    !nullableString(value.post_id) || !nullableString(value.comment_id) ||
    !nullableString(value.project_id) || !nullableString(value.idea_id) ||
    !nullableString(value.event_id) || !nullableString(value.opportunity_id) ||
    !nullableString(value.conversation_id)) return null

  let actor: NotificationRecord['actor'] = null
  if (value.actor !== null) {
    if (!isRecord(value.actor) || typeof value.actor.id !== 'string' ||
      typeof value.actor.username !== 'string' || typeof value.actor.display_name !== 'string' ||
      !nullableString(value.actor.avatar_url)) return null
    actor = {
      id: value.actor.id,
      username: value.actor.username,
      display_name: value.actor.display_name,
      avatar_url: value.actor.avatar_url,
    }
  }

  return {
    id: value.id,
    type: value.type,
    body: null,
    is_read: value.is_read,
    created_at: value.created_at,
    post_id: value.post_id,
    comment_id: value.comment_id,
    project_id: value.project_id,
    idea_id: value.idea_id,
    event_id: value.event_id,
    opportunity_id: value.opportunity_id,
    conversation_id: value.conversation_id,
    actor,
  }
}

/** The installed ordinary reader constructs these Sets/Map in both data modes. */
function validTargetIndex(value: unknown): value is TargetIndex {
  if (!isRecord(value)) return false
  const sets = [
    value.posts, value.comments, value.ideas, value.events,
    value.opportunities, value.conversations,
  ]
  return sets.every((set) => set instanceof Set &&
    [...set].every((id: unknown) => typeof id === 'string' && id.length > 0)) &&
    value.projects instanceof Map &&
    [...value.projects].every(([id, slug]: [unknown, unknown]) =>
      typeof id === 'string' && id.length > 0 && typeof slug === 'string' && slug.length > 0,
    )
}

/** Server-only, eager header preparation; never a client lazy-fetch or mutation. */
export async function loadNotificationHeaderPreview(): Promise<NotificationHeaderPreviewModel> {
  try {
    // .returns<T>() in the hosted reader is a type assertion, not runtime
    // validation. A malformed answer is an error, never an invented empty list.
    const result: unknown = await getNotifications({ limit: PREVIEW_LIMIT })
    if (!isRecord(result) || result.error !== null || !Array.isArray(result.notifications)) {
      return { status: 'error' }
    }

    const rows: NotificationRecord[] = []
    for (const candidate of result.notifications.slice(0, PREVIEW_LIMIT)) {
      const row = sanitizedRow(candidate)
      if (!row) return { status: 'error' }
      rows.push(row)
    }
    if (rows.length === 0) return { status: 'empty' }

    // The real reader already authorizes recipient, actor and activity.
    // Resolve at most five sanitized rows, with no free-text moderation/body data.
    let index = emptyTargetIndex()
    let linksResolved = false
    try {
      const targets: unknown = await getTargetIndex(rows)
      if (isRecord(targets) && targets.error === null && validTargetIndex(targets.index)) {
        index = targets.index
        linksResolved = true
      }
    } catch (error) {
      unstable_rethrow(error)
    }

    return {
      status: 'ready',
      linksResolved,
      views: rows.map((row) => {
        const view = toNotificationView(row, index)
        return {
          ...view,
          detail: null,
          // A failed lookup is unknown, not a successful unreadable/deleted
          // result. Do not retain speculative links or negative conclusions.
          target: linksResolved ? view.target : null,
          targetUnavailable: linksResolved && view.targetUnavailable,
        }
      }),
    }
  } catch (error) {
    unstable_rethrow(error)
    return { status: 'error' }
  }
}

/** Synchronous server presentation seam; not an async-RSC unit-test substitute. */
export function NotificationHeaderPreviewContent({ model }: { model: NotificationHeaderPreviewModel }) {
  return (
    <>
      {model.status === 'error' ? (
        <p role="alert" className="text-sm text-ink-muted">Your notification preview could not be loaded.</p>
      ) : model.status === 'empty' ? (
        <p className="text-sm text-ink-muted">No notifications yet.</p>
      ) : (
        <>
          {!model.linksResolved ? (
            <p role="status" className="mb-3 text-xs text-ink-muted">
              Notification links could not be resolved just now. The activity below is still accurate.
            </p>
          ) : null}
          <ul aria-label="Recent notifications" className="divide-y divide-hairline">
            {model.views.slice(0, PREVIEW_LIMIT).map((view) => (
              <NotificationRow key={view.id} view={{ ...view, detail: null }} linksResolved={model.linksResolved} />
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 border-t border-hairline pt-3">
        <Link href="/notifications" prefetch={false} data-notification-overview
          className="flex min-h-11 items-center rounded px-3 text-sm font-medium text-accent-700 hover:bg-paper-sunken">
          View all notifications
        </Link>
      </div>
    </>
  )
}

export async function NotificationHeaderPreview() {
  return <NotificationHeaderPreviewContent model={await loadNotificationHeaderPreview()} />
}
