'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { mutate } from '@/lib/local/db'
import { createClient, getUser } from '@/lib/supabase/server'
import type { MarkReadOutcome } from '@/features/notifications/types'

/**
 * Marking notifications read.
 *
 * Two actions, not one with a mode flag: "read this one" carries an id and "read
 * everything" carries nothing, and a single action that switches on the presence of an
 * id is where a request that should have been refused becomes a request that marks the
 * whole list.
 *
 * WHAT THE DATABASE DECIDES
 * -------------------------
 * `notifications` has an UPDATE policy for the recipient and a column grant on
 * `is_read` alone (0014). So the update below cannot touch `type`, `body`, the actor or
 * any target id even if this code were wrong, and another reader's row is not visible to
 * the statement at all — `eq('is_read', false)` therefore matches nothing rather than
 * refusing loudly.
 *
 * That is why both actions treat "no rows changed" as a success with `marked: 0`
 * instead of an error: the row was already read, or it is not yours, and in both cases
 * the honest answer to the reader is that there is nothing left to mark. The one thing
 * that must not happen is a message claiming something was marked when it was not, so
 * the number returned is what the database actually returned.
 *
 * WHAT LOCAL MODE REPLACES, AND HOW
 * ---------------------------------
 * There is no policy engine, so the same two rules are written out against the store and
 * nothing else is written: `recipient_id` must be the reader's own profile, and only
 * `is_read` is ever assigned. A row belonging to someone else is skipped — the equivalent
 * of the UPDATE statement not seeing it at all — so the count returned is still "rows this
 * reader's request actually changed", and a click on a stale or foreign id is `marked: 0`,
 * not a refusal and not a lie.
 *
 * The id format differs by mode for the same reason: Supabase ids are uuids, and the uuid
 * check on the form value is what keeps a hand-edited `id` field from reaching SQL as
 * something that is not an id at all. Local ids are opaque `ntf_…` strings, so the local
 * check is the shape those ids actually have.
 *
 * The header's badge is read in the root layout, so `revalidatePath('/', 'layout')` is
 * the call that refreshes it. Revalidating only `/notifications` leaves a count on
 * screen that the page behind it no longer agrees with.
 */

const UNAVAILABLE = 'This deployment has no database connection, so nothing can be saved.'

function revalidateNotificationSurfaces() {
  revalidatePath('/notifications')
  revalidatePath('/', 'layout')
}

const idSchema = z.string().uuid()

/**
 * `id('ntf')` produces `<prefix>_<base36 timestamp><base36 random>`: a lowercase prefix,
 * an underscore, then lowercase alphanumerics. Matching that exactly is the local
 * equivalent of the uuid check — a value that is not shaped like an id cannot be one.
 */
const localIdSchema = z.string().regex(/^[a-z]+_[a-z0-9]{1,64}$/, 'not a local id')

/** The reader's profile — the row notifications are addressed to. */
function profileOf(db: { profiles: { id: string; user_id: string }[] }, userId: string) {
  return db.profiles.find((profile) => profile.user_id === userId) ?? null
}

/**
 * Mark one notification read, as a form action.
 *
 * Form-shaped (`FormData` in, nothing out) because the control that calls it is a plain
 * form inside the server-rendered list: no client component, no JavaScript, and the
 * button still works with the page hydrated or not.
 */
export async function markOneReadAction(formData: FormData): Promise<void> {
  const raw = String(formData.get('id') ?? '')

  if (isLocalMode()) {
    const parsedLocal = localIdSchema.safeParse(raw)
    if (!parsedLocal.success) return

    const user = await getUser()
    if (!user) return

    const marked = await mutate<number>((db) => {
      const profile = profileOf(db, user.id)
      if (!profile) return 0

      let changed = 0
      for (const notification of db.notifications) {
        if (notification.id !== parsedLocal.data) continue
        // The policy, in TypeScript: only the recipient's own row is reachable.
        if (notification.recipient_id !== profile.id) continue
        // `eq('is_read', false)`: an already-read row is not a change.
        if (notification.is_read) continue
        // The column grant: `is_read` and nothing else.
        notification.is_read = true
        changed += 1
      }
      return changed
    })

    if (marked > 0) revalidateNotificationSurfaces()
    return
  }

  if (!isSupabaseConfigured()) return

  const parsed = idSchema.safeParse(raw)
  if (!parsed.success) return

  const user = await getUser()
  if (!user) return

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', parsed.data)
    .eq('is_read', false)
    .select('id')

  if (error) {
    console.error('[notifications:markOne]', error.code, error.message)
    return
  }

  if ((data ?? []).length > 0) revalidateNotificationSurfaces()
}

/** Mark every unread notification read. Returns what the database actually changed. */
export async function markAllReadAction(): Promise<MarkReadOutcome> {
  if (isLocalMode()) {
    const user = await getUser()
    if (!user) return { ok: false, message: 'Sign in again to mark these as read.' }

    const marked = await mutate<number>((db) => {
      const profile = profileOf(db, user.id)
      if (!profile) return 0

      let changed = 0
      for (const notification of db.notifications) {
        // The recipient policy again — one reader's "all" is not another reader's.
        if (notification.recipient_id !== profile.id) continue
        if (notification.is_read) continue
        notification.is_read = true
        changed += 1
      }
      return changed
    })

    if (marked > 0) revalidateNotificationSurfaces()
    // Zero is a success: another tab may have marked them first. Same contract as above.
    return { ok: true, marked }
  }

  if (!isSupabaseConfigured()) return { ok: false, message: UNAVAILABLE }

  const user = await getUser()
  if (!user) return { ok: false, message: 'Sign in again to mark these as read.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('is_read', false)
    .select('id')

  if (error) {
    console.error('[notifications:markAll]', error.code, error.message)
    return { ok: false, message: 'Those could not be marked as read. Try again.' }
  }

  const marked = (data ?? []).length
  if (marked > 0) revalidateNotificationSurfaces()
  return { ok: true, marked }
}
