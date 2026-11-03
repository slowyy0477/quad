import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore } from '@/lib/local/db'
import { canReadContent, canReadProfile, localActor, validLocalId, blockedPair } from '@/lib/local/access'
import type { FormState } from '@/lib/form-state'
import type { IdeaInterestRow } from './queries'
import { ideaInterestSchema } from './schemas'

export async function ideaParticipationLocal(form: FormData, operation: 'vote' | 'interest' | 'withdraw'): Promise<FormState> {
  const ideaId = String(form.get('ideaId') ?? '')
  if (!validLocalId(ideaId)) return { status: 'error', message: 'That action is not available.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null); const idea = db.ideas.find(row => row.id === ideaId)
    if (!me || !idea || !canReadContent(db, idea, idea.author_id, me, 'idea')) return { status: 'error', message: 'That action is not available.' }
    if (operation === 'vote') {
      const voted = String(form.get('voted') ?? '')
      if (!['true','false'].includes(voted)) return { status: 'error', message: 'Check the fields.' }
      if (voted === 'true') db.idea_votes = db.idea_votes.filter(row => row.idea_id !== ideaId || row.profile_id !== me.id)
      else if (!db.idea_votes.some(row => row.idea_id === ideaId && row.profile_id === me.id)) db.idea_votes.push({ id: id('vot'), idea_id: ideaId, profile_id: me.id, created_at: now() })
      idea.upvote_count = db.idea_votes.filter(row => row.idea_id === ideaId).length
    } else {
      const existing = db.idea_interest.find(row => row.idea_id === ideaId && row.profile_id === me.id)
      if (operation === 'withdraw') { if (!existing) return { status: 'error', message: 'No offer of yours exists.' }; db.idea_interest = db.idea_interest.filter(row => row.id !== existing.id) }
      else {
        if (existing || idea.author_id === me.id || idea.status !== 'open') return { status: 'error', message: 'You cannot offer to help with this idea.' }
        const parsed = ideaInterestSchema.safeParse({ message: String(form.get('message') ?? ''), offering: String(form.get('offering') ?? '') })
        if (!parsed.success) return { status: 'error', message: 'Check the fields.' }
        db.idea_interest.push({ id: id('ifi'), idea_id: ideaId, profile_id: me.id, message: parsed.data.message ?? null, offering: parsed.data.offering ?? null, created_at: now() })
      }
      idea.interest_count = db.idea_interest.filter(row => row.idea_id === ideaId).length
    }
    return { status: 'success', message: 'Saved.' }
  })
}
export async function ideaInterestsLocal(ideaId: string): Promise<IdeaInterestRow[]> {
  const db = await readStore(); const user = await getUser(); const me = localActor(db, user?.id ?? null); const idea = db.ideas.find(row => row.id === ideaId)
  if (!me || !idea || !canReadContent(db, idea, idea.author_id, me, 'idea')) return []
  return db.idea_interest.filter(row => row.idea_id === ideaId && (idea.author_id === me.id || row.profile_id === me.id) && !blockedPair(db, me.id, row.profile_id)).map(row => {
    const profile = db.profiles.find(profile => profile.id === row.profile_id)
    return { profile_id: row.profile_id, message: row.message, offering: row.offering, created_at: row.created_at, profile: profile && canReadProfile(db, profile, me) ? { id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url, headline: profile.department } : null }
  })
}
