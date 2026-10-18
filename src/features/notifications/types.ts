/**
 * Notification view models.
 *
 * Apart from `queries.ts` for the reason `messages/types.ts` is: that file imports
 * 'server-only', and the components and their tests need these shapes. Nothing here
 * touches the database.
 *
 * The distinction that carries the most weight is between a notification whose
 * target is gone and one that never had a target. A follow or an achievement has no
 * thing to open; a like on a post that has since been deleted, or that the reader may
 * no longer see, has a target they cannot reach. The first renders as a sentence and
 * is complete. The second has to say so, because the alternative is a link that
 * 404s — and the typed foreign keys make "gone" the common case rather than a
 * corruption: deleting a post cascades to its notifications, so a notification
 * outliving its target means the target is invisible to this reader, not that the
 * row is broken.
 */

/** Where a notification points, and what the link says it will open. */
export type NotificationTarget = {
  href: string
  label: string
}

export type NotificationView = {
  id: string
  type: string
  is_read: boolean
  created_at: string
  /** The sentence. Composed from the type and the joined rows, never stored. */
  text: string
  /**
   * The moderation note, when there is one. `notifications.body` is deliberately
   * the only free text in the table, and only moderation uses it.
   */
  detail: string | null
  /** The actor's display name and picture, or null when the profile is not readable. */
  actorName: string | null
  actorAvatar: string | null
  /** Null when there is nothing to open, or nothing this reader may open. */
  target: NotificationTarget | null
  /** True only when the notification *had* a target that this reader cannot reach. */
  targetUnavailable: boolean
  /** True when `type` is not one this build knows how to describe. */
  unknownType: boolean
}

export type NotificationDay = {
  key: string
  label: string
  items: NotificationView[]
}

/** The result of a direct (non-form) action call. See `messages/types.ts`. */
export type MarkReadOutcome = { ok: true; marked: number } | { ok: false; message: string }
