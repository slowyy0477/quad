import { getUser } from '@/lib/supabase/server'
import { awardConnectionAchievement } from '@/features/learning/local-achievements'
import { id, mutate, now } from '@/lib/local/db'
import { canReadProfile, localActor, validLocalId, blockedPair } from '@/lib/local/access'
import type { FormState } from '@/lib/form-state'

export async function graphLocal(form: FormData, operation: 'request' | 'accepted' | 'rejected' | 'remove' | 'block' | 'unblock'): Promise<FormState> {
  const targetId = String(form.get('profileId') ?? '')
  const connectionId = String(form.get('connectionId') ?? '')
  if (!validLocalId(['request', 'block', 'unblock'].includes(operation) ? targetId : connectionId)) return { status: 'error', message: 'That action is not available.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me) return { status: 'error', message: 'Sign in with an active account first.' }
    db.connections ??= []; db.blocks ??= []; db.follows ??= []
    if (['accepted', 'rejected', 'remove'].includes(operation)) {
      const row = db.connections.find(candidate => candidate.id === connectionId)
      if (!row || blockedPair(db, row.requester_id, row.addressee_id)) return { status: 'error', message: 'That action is not available.' }
      if (operation === 'remove') {
        if (![row.requester_id, row.addressee_id].includes(me.id)) return { status: 'error', message: 'That action is not available.' }
        db.connections = db.connections.filter(candidate => candidate.id !== row.id)
      } else {
        if (row.addressee_id !== me.id || row.status !== 'pending') return { status: 'error', message: 'That action is not available.' }
        row.status = operation as 'accepted' | 'rejected'; row.responded_at = now()
        if (operation === 'accepted') awardConnectionAchievement(db, [row.requester_id, row.addressee_id])
      }
      return { status: 'success', message: 'Saved.' }
    }
    if (targetId === me.id) return { status: 'error', message: 'You cannot do that to yourself.' }
    if (operation === 'unblock') {
      const own = db.blocks.find(row => row.blocker_id === me.id && row.blocked_id === targetId)
      if (!own) return { status: 'error', message: 'That action is not available.' }
      db.blocks = db.blocks.filter(row => row.id !== own.id)
      return { status: 'success', message: 'Unblocked.' }
    }
    const target = db.profiles.find(row => row.id === targetId)
    const ownBlock = db.blocks.some(row => row.blocker_id === me.id && row.blocked_id === targetId)
    if (!target || (!ownBlock && !canReadProfile(db, target, me))) return { status: 'error', message: 'That action is not available.' }
    if (operation === 'block') {
      const reason = String(form.get('reason') ?? '').trim()
      if (reason.length > 500) return { status: 'error', message: 'Use at most 500 characters.' }
      if (!ownBlock) db.blocks.push({ id: id('blk'), blocker_id: me.id, blocked_id: targetId, reason: reason || null, created_at: now() })
      db.connections = db.connections.filter(row => !([row.requester_id, row.addressee_id].includes(me.id) && [row.requester_id, row.addressee_id].includes(targetId)))
      db.follows = db.follows.filter(row => !([row.follower_id, row.following_id].includes(me.id) && [row.follower_id, row.following_id].includes(targetId)))
      return { status: 'success', message: 'Blocked.' }
    }
    if (target.allow_connection_requests === false || blockedPair(db, me.id, targetId)) return { status: 'error', message: 'That action is not available.' }
    const previous = db.connections.find(row => [row.requester_id, row.addressee_id].includes(me.id) && [row.requester_id, row.addressee_id].includes(targetId))
    if (previous && previous.status !== 'rejected') return { status: 'error', message: 'A request or connection already exists.' }
    if (previous) db.connections = db.connections.filter(row => row.id !== previous.id)
    const message = String(form.get('message') ?? '').trim()
    if (message.length > 500) return { status: 'error', message: 'Use at most 500 characters.' }
    db.connections.push({ id: id('con'), requester_id: me.id, addressee_id: targetId, status: 'pending', message: message || null, responded_at: null, created_at: now() })
    return { status: 'success', message: 'Request sent.' }
  })
}


export async function followLocal(form: FormData): Promise<FormState> {
  const targetId = String(form.get('profileId') ?? '')
  const follow = String(form.get('follow') ?? '')
  if (!validLocalId(targetId) || !['true', 'false'].includes(follow)) return { status: 'error', message: 'Check the fields.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    const target = db.profiles.find(row => row.id === targetId)
    if (!me || me.id === targetId || !canReadProfile(db, target, me)) return { status: 'error', message: 'That action is not available.' }
    db.follows ??= []
    if (follow === 'true') {
      if (!db.follows.some(row => row.follower_id === me.id && row.following_id === targetId)) db.follows.push({ id: id('fol'), follower_id: me.id, following_id: targetId, created_at: now() })
    } else db.follows = db.follows.filter(row => row.follower_id !== me.id || row.following_id !== targetId)
    return { status: 'success', message: follow === 'true' ? 'Following.' : 'Unfollowed.' }
  })
}
