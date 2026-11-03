'use server'

import { revalidatePath } from 'next/cache'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import { isSupabaseConfigured } from '@/lib/env'
import { localFormWrite } from '@/lib/local/write-result'
import {
  projectInvitationFailure, respondToProjectInvitationLocal, validProjectInvitationId,
  type InviteResponseState,
} from './invitations'

export async function respondToProjectInviteAction(
  _previous: InviteResponseState, form: FormData,
): Promise<InviteResponseState> {
  if (!isLocalMode() && !isSupabaseConfigured()) {
    return { status: 'error', message: 'Project invitations need a configured hosted service.' }
  }
  const inviteId = form.get('inviteId')
  const response = form.get('response')
  if (typeof inviteId !== 'string' || !validProjectInvitationId(inviteId) ||
      (response !== 'accepted' && response !== 'declined')) {
    return { status: 'error', message: 'Choose a valid invitation response.' }
  }
  const user = await getUser()
  if (!user) return { status: 'error', message: 'Sign in to respond to your project invitation.' }
  let result: InviteResponseState
  if (isLocalMode()) {
    result = await localFormWrite(() => respondToProjectInvitationLocal(user.id, inviteId, response))
  } else {
    try {
      const supabase = await createClient()
      // SECURITY INVOKER RPC uses 0007's recipient-only UPDATE policy; no
      // service client, posted identity, or direct membership INSERT.
      const { data, error } = await supabase.rpc('respond_to_project_invite', {
        p_invite_id: inviteId, p_response: response,
      })
      if (error) return projectInvitationFailure(error)
      const row = Array.isArray(data) && data.length === 1 ? data[0] as Record<string, unknown> : null
      if (!row || row.status !== response || typeof row.project_id !== 'string' ||
          !validProjectInvitationId(row.project_id, false) ||
          (response === 'accepted' && (typeof row.project_slug !== 'string' ||
            row.project_slug.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.project_slug)))) {
        return { status: 'error', message: 'The response could not be confirmed. Reload your invitations before trying again.' }
      }
      result = {
        status: 'success', response,
        message: response === 'accepted' ? 'Invitation accepted. You are now a project member.' : 'Invitation declined. You have not joined the project.',
        ...(response === 'accepted' ? { projectPath: `/projects/${row.project_slug}` } : {}),
      }
    } catch { return { status: 'error', message: 'That response could not be saved. Please try again.' } }
  }
  if (result.status === 'success') {
    revalidatePath('/projects')
    revalidatePath('/projects/[slug]', 'page')
    revalidatePath('/notifications')
    revalidatePath('/me')
    if (result.projectPath) revalidatePath(result.projectPath)
  }
  return result
}
