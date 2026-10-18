'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { Database } from '@/lib/db/database.types'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { id, mutate, now, type LocalEvent } from '@/lib/local/db'
import { describeWriteError, echoValues, fieldErrorsOf, type FormState } from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { canViewEvent, localEventSlug } from '@/features/events/queries'
import { eventCreateSchema, rsvpSchema, type EventCreateInput } from '@/features/events/schemas'
import { zonedToUtc } from '@/features/events/when'

/**
 * Event writes.
 *
 * The rules that matter are in 0013 and none of them is re-implemented here:
 *
 *   * `created_by`, the slug, the university and both counters come from the trigger;
 *   * the visibility is clamped to the creator's profile visibility (and to the project's,
 *     when the event belongs to one);
 *   * capacity is enforced under a row lock, so two simultaneous RSVPs cannot both take
 *     the last place -- this file maps that refusal, it does not prevent the race;
 *   * `going` consumes a place and `interested` does not.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so events cannot be saved.',
}

type EventInsert = Database['public']['Tables']['events']['Insert']

/**
 * `slug` and `created_by` are required by the generated Insert type because their columns
 * are NOT NULL; the trigger assigns both on every insert. Sending a placeholder slug would
 * be a claim that the author chose the URL, and sending a creator would be a claim the
 * trigger overwrites, so both are omitted and the type is narrowed.
 */
type EventWrite = Omit<EventInsert, 'slug' | 'created_by'>

function readForm(formData: FormData) {
  return {
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    type: String(formData.get('type') ?? 'other'),
    attendanceMode: String(formData.get('attendanceMode') ?? 'onsite'),
    visibility: String(formData.get('visibility') ?? 'public'),
    timeZone: String(formData.get('timeZone') ?? 'Asia/Karachi'),
    startsAt: String(formData.get('startsAt') ?? ''),
    endsAt: String(formData.get('endsAt') ?? ''),
    location: String(formData.get('location') ?? ''),
    locationUrl: String(formData.get('locationUrl') ?? ''),
    joinUrl: String(formData.get('joinUrl') ?? ''),
    capacity: String(formData.get('capacity') ?? ''),
    isAllDay: String(formData.get('isAllDay') ?? ''),
  }
}

// -----------------------------------------------------------------------------
// Creating an event
// -----------------------------------------------------------------------------

export async function createEventAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/events/new')

  const parsed = eventCreateSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const startsAt = zonedToUtc(parsed.data.startsAt, parsed.data.timeZone)
  if (!startsAt) {
    return {
      status: 'error',
      fieldErrors: { startsAt: 'That start date and time could not be read' },
      values: echoValues(formData),
    }
  }

  const endsAt = parsed.data.endsAt ? zonedToUtc(parsed.data.endsAt, parsed.data.timeZone) : null
  if (parsed.data.endsAt && !endsAt) {
    return {
      status: 'error',
      fieldErrors: { endsAt: 'That end date and time could not be read' },
      values: echoValues(formData),
    }
  }

  // `events_span_ordered`. Checked here as well as in the database so the author is told
  // which of the two fields is wrong rather than that one of them is.
  if (endsAt && endsAt.getTime() < startsAt.getTime()) {
    return {
      status: 'error',
      fieldErrors: { endsAt: 'The end has to be after the start' },
      values: echoValues(formData),
    }
  }

  const row: EventWrite = {
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    type: parsed.data.type,
    attendance_mode: parsed.data.attendanceMode,
    visibility: parsed.data.visibility,
    time_zone: parsed.data.timeZone,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt ? endsAt.toISOString() : null,
    is_all_day: parsed.data.isAllDay,
    location: parsed.data.location ?? null,
    location_url: parsed.data.locationUrl ?? null,
    join_url: parsed.data.joinUrl ?? null,
    capacity: parsed.data.capacity ?? null,
  }

  if (isLocalMode()) return createEventLocal(user.id, parsed.data, startsAt, endsAt, formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .insert(row as EventInsert)
    .select('slug, visibility')
    .single<{ slug: string; visibility: string }>()

  if (error) {
    return { ...describeWriteError(error, 'events:create'), values: echoValues(formData) }
  }

  revalidatePath('/events')

  // The trigger clamps visibility to the creator's profile. Saying so on arrival is better
  // than letting the organiser believe a university-only event stayed where they put it.
  const clamped = parsed.data.visibility !== data.visibility

  redirect(`/events/${data.slug}?created=1${clamped ? '&clamped=1' : ''}`)
}

// -----------------------------------------------------------------------------
// RSVPs
// -----------------------------------------------------------------------------

/**
 * A refusal from `event_attendees_before_write`, said in a sentence.
 *
 * The trigger raises 42501 with a hint for two different situations (not visible, and
 * cancelled) and 23514 for a full event. The hint is our own fixed sentinel rather than
 * driver text, so reading it is safe; the message is logged and never rendered.
 */
function describeRsvpError(error: { code?: string; message?: string; hint?: string | null }): FormState {
  console.error('[events:rsvp]', error.code, error.message)

  if (error.code === '42501') {
    return {
      status: 'error',
      message:
        error.hint === 'event_cancelled'
          ? 'That event has been cancelled, so there is nothing to sign up for.'
          : 'That event is not one you can see, so it cannot be answered.',
    }
  }

  if (error.code === '23514') {
    return {
      status: 'error',
      message:
        'Every place is taken. The event has a capacity and it is full — if someone cancels, a place opens.',
    }
  }

  return describeWriteError(error, 'events:rsvp')
}

/**
 * Say you are going, or interested.
 *
 * Insert first and fall back to an update on 23505, rather than an upsert: an upsert sends
 * every column into the conflict branch, and `event_attendees` refuses an UPDATE that
 * touches `event_id` or `profile_id`. The fallback is also what a double-click produces,
 * so it is the ordinary path and not an error.
 *
 * `profile_id` is sent because the column is NOT NULL and the insert policy reads it; the
 * trigger overwrites it with `auth.uid()` regardless.
 */
export async function rsvpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const eventId = String(formData.get('eventId') ?? '')
  const slug = String(formData.get('slug') ?? '')

  if (!eventId) return { status: 'error', message: 'That event could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/events/${slug}`)

  const parsed = rsvpSchema.safeParse({ status: String(formData.get('status') ?? '') })
  if (!parsed.success) {
    return { status: 'error', message: 'That is not one of the two answers this control offers.' }
  }

  if (isLocalMode()) return rsvpLocal(user.id, eventId, slug, parsed.data.status)

  const supabase = await createClient()
  const { error } = await supabase
    .from('event_attendees')
    .insert({ event_id: eventId, profile_id: user.id, status: parsed.data.status })

  if (error && error.code === '23505') {
    const { data, error: updateError } = await supabase
      .from('event_attendees')
      .update({ status: parsed.data.status })
      .eq('event_id', eventId)
      .eq('profile_id', user.id)
      .select('status')
      .maybeSingle<{ status: string }>()

    if (updateError) return describeRsvpError(updateError)
    if (!data) return { status: 'error', message: 'That RSVP is not yours to change.' }
  } else if (error) {
    return describeRsvpError(error)
  }

  if (slug) revalidatePath(`/events/${slug}`)
  revalidatePath('/events')

  return {
    status: 'success',
    message:
      parsed.data.status === 'going'
        ? 'You are down as going.'
        : 'Marked as interested. This does not take a place.',
  }
}

/**
 * Cancel an RSVP.
 *
 * A delete of the reader's own row; the policy allows their own and the organiser's, and
 * the action only ever asks for the reader's. Zero rows is not an error worth an alert --
 * it means the answer was already withdrawn.
 */
export async function cancelRsvpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const eventId = String(formData.get('eventId') ?? '')
  const slug = String(formData.get('slug') ?? '')

  if (!eventId) return { status: 'error', message: 'That event could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/events/${slug}`)

  if (isLocalMode()) return cancelRsvpLocal(user.id, eventId, slug)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('event_attendees')
    .delete()
    .eq('event_id', eventId)
    .eq('profile_id', user.id)
    .select('event_id')
    .maybeSingle<{ event_id: string }>()

  if (error) return describeWriteError(error, 'events:cancelRsvp')
  if (!data) return { status: 'error', message: 'You had no answer recorded on this event.' }

  if (slug) revalidatePath(`/events/${slug}`)
  revalidatePath('/events')
  return { status: 'success', message: 'Your answer was removed.' }
}

// =============================================================================
// Local mode
//
// The store has no policies and no triggers, so the checks and the counter
// maintenance below are the only ones there are. Each mirrors a named piece of
// 0013: `events_before_write` (the visibility clamp and the slug),
// `event_attendees_before_write` (visibility, cancellation, capacity under a
// lock), and `app.sync_event_attendee_counts` (recompute, never increment).
//
// Columns the local event row does not have are accepted by the form and not
// stored: `type`, `attendance_mode`, `is_all_day`, `join_url`, `location_url`
// and `project_id`. The read path states what that means for each shape --
// see the note at the top of the local section in `queries.ts`.
// =============================================================================

const NO_PROFILE: FormState = {
  status: 'error',
  message: 'This account has no profile in the local store, so nothing can be saved under it.',
}

/** `app.visibility_rank`: four levels are a total order, so clamping is a comparison. */
function visibilityRank(value: string): number {
  if (value === 'public') return 3
  if (value === 'university') return 2
  if (value === 'connections') return 1
  return 0
}

/** `app.clamp_visibility`: the less visible of the two. */
function clampVisibility(requested: string, ceiling: string): string {
  return visibilityRank(requested) <= visibilityRank(ceiling) ? requested : ceiling
}

async function createEventLocal(
  userId: string,
  data: EventCreateInput,
  startsAt: Date,
  endsAt: Date | null,
  formData: FormData,
): Promise<FormState> {
  const created = await mutate((db) => {
    const creator = db.profiles.find((profile) => profile.user_id === userId)
    if (!creator) return null

    // `events_before_write`: an event is never more visible than the profile that
    // created it. A local event belongs to no project, so the project clause of
    // that trigger has nothing to clamp against.
    const visibility = clampVisibility(data.visibility, creator.visibility)

    const row: LocalEvent = {
      id: id('evt'),
      // The trigger sets `created_by` from `auth.uid()`; locally that is the
      // reader's profile, which is also what the insert policy checks.
      created_by: creator.id,
      title: data.title.trim(),
      // The column is not nullable; the form's description is optional.
      description: data.description ?? '',
      location: data.location ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      // The local column is `timezone` and holds the same IANA zone the form sent.
      timezone: data.timeZone,
      capacity: data.capacity ?? null,
      attendee_count: 0,
      visibility,
      status: 'scheduled',
      created_at: now(),
      deleted_at: null,
    }

    // Push first, then ask the read path what slug this row was given, so the
    // redirect and the detail page cannot disagree about the URL.
    db.events.push(row)
    const slug = localEventSlug(db, row.id)

    return { slug, visibility, requested: data.visibility }
  })

  if (!created) return { ...NO_PROFILE, values: echoValues(formData) }

  revalidatePath('/events')

  const clamped = created.requested !== created.visibility

  redirect(`/events/${created.slug}?created=1${clamped ? '&clamped=1' : ''}`)
}

async function rsvpLocal(
  userId: string,
  eventId: string,
  slug: string,
  status: 'going' | 'interested',
): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'no-profile'

    const event = db.events.find((row) => row.id === eventId && row.deleted_at === null)
    // `event_attendees_before_write` raises 42501 for both of these, with a hint
    // that says which; here they are two answers because the sentences differ.
    if (!event || !canViewEvent(db, event, viewer)) return 'not-visible'
    if (event.status === 'cancelled') return 'cancelled'

    const rows = db.event_attendees.filter((attendee) => attendee.event_id === eventId)
    const existing = rows.find((attendee) => attendee.profile_id === viewer.id)

    // Capacity is what the trigger enforces under a row lock, and only `going`
    // consumes one. A reader switching from going to going is not competing with
    // their own place, so their existing row is not counted against them.
    if (status === 'going' && event.capacity !== null) {
      const going = rows.filter((attendee) => attendee.status === 'going').length
      if (existing?.status !== 'going' && going >= event.capacity) return 'full'
    }

    // One row per (event, profile), idempotent in both directions: asking again
    // is an update, and asking twice for the same answer changes nothing.
    if (existing) {
      existing.status = status
    } else {
      db.event_attendees.push({
        id: id('att'),
        event_id: eventId,
        profile_id: viewer.id,
        status,
        created_at: now(),
      })
    }

    // `app.sync_event_attendee_counts`: recomputed from the rows it describes, so
    // the stored cache cannot drift from the answer that was just written.
    event.attendee_count = db.event_attendees.filter(
      (attendee) => attendee.event_id === eventId && attendee.status === 'going',
    ).length

    return 'ok'
  })

  if (result === 'no-profile') return NO_PROFILE
  if (result === 'not-visible') {
    return { status: 'error', message: 'That event is not one you can see, so it cannot be answered.' }
  }
  if (result === 'cancelled') {
    return {
      status: 'error',
      message: 'That event has been cancelled, so there is nothing to sign up for.',
    }
  }
  if (result === 'full') {
    return {
      status: 'error',
      message:
        'Every place is taken. The event has a capacity and it is full — if someone cancels, a place opens.',
    }
  }

  if (slug) revalidatePath(`/events/${slug}`)
  revalidatePath('/events')

  return {
    status: 'success',
    message:
      status === 'going'
        ? 'You are down as going.'
        : 'Marked as interested. This does not take a place.',
  }
}

async function cancelRsvpLocal(userId: string, eventId: string, slug: string): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'no-profile'

    const index = db.event_attendees.findIndex(
      (row) => row.event_id === eventId && row.profile_id === viewer.id,
    )
    // Zero rows means the answer was already withdrawn. Nothing is wrong, but
    // saying "removed" would describe a write that did not happen, so it is the
    // same sentence the Supabase path uses for a delete that matched nothing.
    if (index < 0) return 'none'

    db.event_attendees.splice(index, 1)

    const event = db.events.find((row) => row.id === eventId)
    if (event) {
      event.attendee_count = db.event_attendees.filter(
        (attendee) => attendee.event_id === eventId && attendee.status === 'going',
      ).length
    }

    return 'ok'
  })

  if (result === 'no-profile') return NO_PROFILE
  if (result === 'none') {
    return { status: 'error', message: 'You had no answer recorded on this event.' }
  }

  if (slug) revalidatePath(`/events/${slug}`)
  revalidatePath('/events')
  return { status: 'success', message: 'Your answer was removed.' }
}
