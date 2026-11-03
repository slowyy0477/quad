import 'server-only'

import type { PostgrestError } from '@supabase/supabase-js'
import type { createClient } from '@/lib/supabase/server'
import type { GroupManagementPane } from './types'

/**
 * Narrow forward-migration adapter while generated provider types still precede
 * 0035. No general any-client cast, service key or caller identity argument.
 */
type GroupRPCs = {
  message_create_group: {
    args: { p_title: string; p_members: string[] }
    data: { conversation_id: string; added: number; skipped: number }
  }
  message_add_group_members: {
    args: { p_conversation_id: string; p_members: string[] }
    data: { added: number; skipped: number }
  }
  message_set_group_role: {
    args: { p_conversation_id: string; p_profile_id: string; p_role: 'admin' | 'member' }
    data: boolean
  }
  message_remove_group_member: {
    args: { p_conversation_id: string; p_profile_id: string }
    data: boolean
  }
  message_leave_conversation: {
    args: { p_conversation_id: string }
    data: boolean
  }
  message_group_members: {
    args: { p_conversation_id: string }
    data: GroupManagementPane
  }
}

export async function callGroupRPC<Name extends keyof GroupRPCs>(
  client: Awaited<ReturnType<typeof createClient>>,
  name: Name,
  args: GroupRPCs[Name]['args'],
): Promise<{ data: GroupRPCs[Name]['data'] | null; error: PostgrestError | null }> {
  const rpc = client.rpc.bind(client) as unknown as (
    functionName: Name, input: GroupRPCs[Name]['args'],
  ) => PromiseLike<{ data: GroupRPCs[Name]['data'] | null; error: PostgrestError | null }>
  return await rpc(name, args)
}
