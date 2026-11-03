import { getUser } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { id, mutate } from '@/lib/local/db'
import { localActor, validLocalId } from '@/lib/local/access'
import { getLocalUserFromSnapshot, LOCAL_SESSION_COOKIE } from '@/lib/local/session'
import { finalGroupAdminLocal } from './local-groups'
import { FINAL_GROUP_ADMIN_COPY } from './group-contract'
import {
  activeMessageMembershipLocal,
  canReadConversationHistoryLocal,
  leaveMessageMembershipLocal,
} from './local-access'
import type { LeaveOutcome, MuteOutcome } from './types'

export async function muteConversationLocal(conversationId: string, muted: boolean): Promise<MuteOutcome> {
  if (!validLocalId(conversationId) || typeof muted !== 'boolean') return { ok: false, message: 'That action is not available.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me || !canReadConversationHistoryLocal(db, conversationId, me)) return { ok: false, message: 'That action is not available.' }
    const existing = db.participant_preferences.find(row => row.conversation_id === conversationId && row.profile_id === me.id)
    if (existing) existing.is_muted = muted
    else db.participant_preferences.push({ id: id('prf'), conversation_id: conversationId, profile_id: me.id, is_muted: muted, left_at: null })
    return { ok: true, muted }
  })
}

export async function leaveConversationLocal(conversationId: string): Promise<LeaveOutcome> {
  if (!validLocalId(conversationId)) return { ok: false, message: 'That action is not available.' }
  const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  return mutate(db => {
    const user = getLocalUserFromSnapshot(db, cookie)
    const me = localActor(db, user?.id ?? null)
    if (!me || !activeMessageMembershipLocal(db, conversationId, me.id)) {
      return { ok: false, message: 'That conversation is not yours to leave.' }
    }
    if (finalGroupAdminLocal(db, conversationId, me)) return { ok: false, message: FINAL_GROUP_ADMIN_COPY }
    if (!leaveMessageMembershipLocal(db, conversationId, me.id, new Date().toISOString())) {
      return { ok: false, message: 'That conversation is not yours to leave.' }
    }
    return { ok: true, left: true }
  })
}
