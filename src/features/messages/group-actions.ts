'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ActionError, action, formInput, requireActiveAccount, toFormState } from '@/lib/action'
import { fieldErrorsOf, type FormState } from '@/lib/form-state'
import { validLocalId } from '@/lib/local/access'
import { localFormWrite, localInteractionWrite } from '@/lib/local/write-result'
import { isLocalMode } from '@/lib/mode'
import type { createClient } from '@/lib/supabase/server'
import {
  addGroupMembersSchema,
  createGroupSchema,
  escapeHandle,
  removeGroupMemberSchema,
  setGroupRoleSchema,
} from './schemas'
import { addGroupMembersLocal, createGroupLocal, removeGroupMemberLocal, setGroupRoleLocal } from './local-groups'
import { callGroupRPC } from './group-rpc'
import {
  FINAL_GROUP_ADMIN_COPY,
  GROUP_UNAVAILABLE_COPY,
  groupAdditionCopy,
} from './group-contract'
import type { GroupChangeOutcome, GroupCreateState } from './types'

const localIdSchema = z.string().refine(validLocalId, 'That group or member could not be identified.')
const localAddSchema = addGroupMembersSchema.extend({ conversationId: localIdSchema })
const localRoleSchema = setGroupRoleSchema.extend({ conversationId: localIdSchema, profileId: localIdSchema })
const localRemoveSchema = removeGroupMemberSchema.extend({ conversationId: localIdSchema, profileId: localIdSchema })

function groupError(error: { code?: string; hint?: string | null }): never {
  if (error.hint === 'final_group_admin') throw new ActionError(FINAL_GROUP_ADMIN_COPY)
  if (error.hint === 'group_no_reachable_members') throw new ActionError(
    'No one was added, so no group was created. Choose a reachable accepted connection.',
  )
  if (error.hint === 'group_member_limit' || error.hint === 'too_many_members') {
    throw new ActionError('Use at most 10 handles per request. Groups allow 20 active and 50 recorded members.')
  }
  if (error.hint === 'account_unavailable') throw new ActionError('Please sign in with an available account to do that.')
  if (error.code === '42501') throw new ActionError(GROUP_UNAVAILABLE_COPY)
  throw error
}

/** At most ten RLS-filtered exact lookups; no private directory results returned. */
async function resolveHandles(client: Awaited<ReturnType<typeof createClient>>, handles: string[]) {
  const found = await Promise.all(handles.map(async handle => {
    const { data, error } = await client.from('profiles')
      .select('id').ilike('username', escapeHandle(handle)).is('deleted_at', null)
      .maybeSingle<{ id: string }>()
    if (error) throw error
    return data?.id ?? null
  }))
  return {
    ids: [...new Set(found.filter((value): value is string => value !== null))],
    unavailable: found.filter(value => value === null).length,
  }
}

const createGroup = action(createGroupSchema).use(requireActiveAccount).run(async ({ input, supabase }) => {
  const found = await resolveHandles(supabase, input.handles)
  if (!found.ids.length) throw new ActionError(
    'No one was added, so no group was created. Choose a reachable accepted connection.',
  )
  const { data, error } = await callGroupRPC(supabase, 'message_create_group', {
    p_title: input.title, p_members: found.ids,
  })
  if (error) groupError(error)
  if (!data?.conversation_id || data.added < 1) throw new ActionError('The group could not be created. Please try again.')
  revalidatePath('/messages')
  return {
    conversationId: data.conversation_id,
    message: `Group created. ${groupAdditionCopy(data.added, data.skipped + found.unavailable)}`,
  }
})

export async function createGroupConversationAction(_previous: GroupCreateState, formData: FormData): Promise<GroupCreateState> {
  if (isLocalMode()) return localFormWrite(async () => {
    const values = formInput(formData)
    const parsed = createGroupSchema.safeParse(values)
    if (!parsed.success) return {
      status: 'error' as const, message: 'Check the fields marked below.',
      fieldErrors: fieldErrorsOf(parsed.error), values,
    }
    const result = await createGroupLocal(parsed.data.title, parsed.data.handles)
    if (!result.ok) return { status: 'error' as const, message: result.message, values }
    revalidatePath('/messages')
    return {
      status: 'success' as const, conversationId: result.conversationId,
      message: `Group created. ${groupAdditionCopy(result.added, result.skipped)}`,
    }
  }, formData)
  const result = await createGroup(formInput(formData))
  return result.ok
    ? { status: 'success', conversationId: result.value.conversationId, message: result.value.message }
    : toFormState(result, '', formData)
}

const addMembers = action(addGroupMembersSchema).use(requireActiveAccount).run(async ({ input, supabase }) => {
  const found = await resolveHandles(supabase, input.handles)
  // Even an entirely unavailable candidate list still asks the guarded RPC to
  // authorize the group. Zero additions never implies permission for an attacker.
  const { data, error } = await callGroupRPC(supabase, 'message_add_group_members', {
    p_conversation_id: input.conversationId, p_members: found.ids,
  })
  if (error) groupError(error)
  if (!data) throw new ActionError(GROUP_UNAVAILABLE_COPY)
  if (data.added > 0) revalidatePath('/messages')
  return { added: data.added, message: groupAdditionCopy(data.added, data.skipped + found.unavailable) }
})

export async function addGroupMembersAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (isLocalMode()) return localFormWrite(async () => {
    const values = formInput(formData)
    const parsed = localAddSchema.safeParse(values)
    if (!parsed.success) return {
      status: 'error' as const, message: 'Check the fields marked below.',
      fieldErrors: fieldErrorsOf(parsed.error), values,
    }
    const result = await addGroupMembersLocal(parsed.data.conversationId, parsed.data.handles)
    if (!result.ok) return { status: 'error' as const, message: result.message, values }
    if (result.added > 0) revalidatePath('/messages')
    return {
      status: result.added > 0 ? 'success' as const : 'error' as const,
      message: groupAdditionCopy(result.added, result.skipped),
      ...(result.added === 0 ? { values } : {}),
    }
  }, formData)
  const result = await addMembers(formInput(formData))
  const state = toFormState(result, '', formData)
  // A successful authorized RPC may still add nobody. Do not label that as saved.
  return result.ok && result.value.added === 0
    ? { ...state, status: 'error', values: formInput(formData) } : state
}

const setRole = action(setGroupRoleSchema).use(requireActiveAccount).run(async ({ input, supabase }) => {
  const { data, error } = await callGroupRPC(supabase, 'message_set_group_role', {
    p_conversation_id: input.conversationId, p_profile_id: input.profileId, p_role: input.role,
  })
  if (error) groupError(error)
  if (data !== true) throw new ActionError(GROUP_UNAVAILABLE_COPY)
  revalidatePath('/messages')
  return { message: 'Member role saved.' }
})

export async function setGroupMemberRoleAction(
  conversationId: string, profileId: string, role: 'admin' | 'member',
): Promise<GroupChangeOutcome> {
  if (isLocalMode()) return localInteractionWrite(async () => {
    const parsed = localRoleSchema.safeParse({ conversationId, profileId, role })
    if (!parsed.success) return { ok: false as const, message: 'That member role could not be identified.' }
    const result = await setGroupRoleLocal(conversationId, profileId, role)
    if (result.ok) revalidatePath('/messages')
    return result
  })
  const result = await setRole({ conversationId, profileId, role })
  return result.ok ? { ok: true, message: result.value.message } : { ok: false, message: result.error }
}

const removeMember = action(removeGroupMemberSchema).use(requireActiveAccount).run(async ({ input, supabase }) => {
  const { data, error } = await callGroupRPC(supabase, 'message_remove_group_member', {
    p_conversation_id: input.conversationId, p_profile_id: input.profileId,
  })
  if (error) groupError(error)
  if (data !== true) throw new ActionError(GROUP_UNAVAILABLE_COPY)
  revalidatePath('/messages')
  return { message: 'Member removed. Their permitted history remains readable.' }
})

export async function removeGroupMemberAction(conversationId: string, profileId: string): Promise<GroupChangeOutcome> {
  if (isLocalMode()) return localInteractionWrite(async () => {
    const parsed = localRemoveSchema.safeParse({ conversationId, profileId })
    if (!parsed.success) return { ok: false as const, message: 'That member could not be identified.' }
    const result = await removeGroupMemberLocal(conversationId, profileId)
    if (result.ok) revalidatePath('/messages')
    return result
  })
  const result = await removeMember({ conversationId, profileId })
  return result.ok ? { ok: true, message: result.value.message } : { ok: false, message: result.error }
}
