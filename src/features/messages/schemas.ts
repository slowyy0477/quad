/**
 * Messaging form schemas.
 *
 * Kept out of `actions.ts` for the reason the other features keep theirs apart: a
 * `'use server'` module may only export async functions, and a schema is a value.
 *
 * These mirror what the database already enforces, and they are not a substitute
 * for it:
 *
 *   `messages_not_empty`      btrim(body) <> ''          → `min(1)` after trim
 *   `messages_body_length`    length(body) <= 4000       → `max(4000)`
 *   the trigger               sender_id := auth.uid()     → no field for it at all
 *   `app.can_message`         who may open what           → checked in the action
 *
 * The refusals that belong to the database stay there; these only catch what a
 * form can obviously get wrong, with a sentence the reader can act on.
 */

import { z } from 'zod'

export const sendMessageSchema = z.object({
  conversationId: z.string().uuid('That conversation could not be identified.'),
  body: z
    .string()
    .trim()
    .min(1, 'Write a message first.')
    .max(4000, 'Messages are at most 4000 characters.'),
})

export const startConversationSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'A handle is at least 3 characters.')
    .max(30, 'A handle is at most 30 characters.'),
})

export const markReadSchema = z.object({
  conversationId: z.string().uuid('That conversation could not be identified.'),
})

export const setMutedSchema = z.object({
  conversationId: z.string().uuid('That conversation could not be identified.'),
  muted: z.boolean(),
})

/** The handle as `ilike` needs it: no wildcards, however the constraint changes. */
export function escapeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').replace(/[%_\\]/g, '\\$&')
}
