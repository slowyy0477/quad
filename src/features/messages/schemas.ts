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
import { GROUP_HANDLE_LIMIT, GROUP_TITLE_LIMIT } from './group-contract'

export const sendMessageSchema = z.object({
  conversationId: z.string().uuid('That conversation could not be identified.'),
  clientNonce: z.string().uuid('That send could not be identified.').optional(),
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

/** Handles, not a directory search or client-selected participant identities. */
export const groupHandlesSchema = z.string()
  .max(500, 'Use at most 10 handles.')
  .transform(value => [...new Set(value.split(/[\s,;]+/)
    .map(handle => handle.replace(/^@/, '').toLowerCase())
    .filter(Boolean))])
  .pipe(z.array(z.string().min(3).max(30).regex(
    /^[a-z0-9_.]+$/, 'Use handles separated by commas or spaces.',
  )).min(1, 'Add at least one other person.').max(GROUP_HANDLE_LIMIT, 'Use at most 10 handles.'))

export const createGroupSchema = z.object({
  title: z.string().trim().min(1, 'Give the group a name.')
    .max(GROUP_TITLE_LIMIT, 'Group names are at most 120 characters.'),
  handles: groupHandlesSchema,
})

export const addGroupMembersSchema = z.object({
  conversationId: z.string().uuid('That group could not be identified.'),
  handles: groupHandlesSchema,
})

export const setGroupRoleSchema = z.object({
  conversationId: z.string().uuid('That group could not be identified.'),
  profileId: z.string().uuid('That member could not be identified.'),
  role: z.enum(['admin', 'member']),
})

export const removeGroupMemberSchema = z.object({
  conversationId: z.string().uuid('That group could not be identified.'),
  profileId: z.string().uuid('That member could not be identified.'),
})

/** The handle as `ilike` needs it: no wildcards, however the constraint changes. */
export function escapeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').replace(/[%_\\]/g, '\\$&')
}
