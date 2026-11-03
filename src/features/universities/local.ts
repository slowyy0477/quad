import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore } from '@/lib/local/db'
import { localActor, localStaff, validLocalId } from '@/lib/local/access'
import type { FormState } from '@/lib/form-state'
import type { UniversityRequestInput } from './schemas'
import type { PendingUniversity } from '@/features/moderation/queries'
import { universityReviewSchema } from '@/features/moderation/schemas'

export async function universityRequestLocal(input: UniversityRequestInput): Promise<FormState> {
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me) return { status: 'error', message: 'Sign in to request an institution.' }
    const duplicate = (name: string, country: string | null) => name.trim().toLocaleLowerCase() === input.name.toLocaleLowerCase() && (country ?? '').toLocaleLowerCase() === (input.country ?? '').toLocaleLowerCase()
    if (db.universities.some(row => duplicate(row.name,row.country)) || db.university_requests.some(row => row.status !== 'rejected' && duplicate(row.name,row.country))) return { status: 'error', message: 'That institution is already listed or has been filed.' }
    db.university_requests.push({ id: id('uni'), name: input.name, short_name: input.shortName ?? null, city: input.city ?? null, country: input.country ?? null, website: input.website ?? null, submitted_by: me.id, status: 'pending', reason: null, reviewed_by: null, reviewed_at: null, created_at: now() })
    return { status: 'success', message: 'Filed. A moderator reviews new institutions; until one does, this appears only in your pending list.' }
  })
}
export async function universityReviewLocal(form: FormData): Promise<FormState> {
  const universityId = String(form.get('universityId') ?? '')
  const parsed = universityReviewSchema.omit({ universityId: true }).safeParse({ decision: String(form.get('decision') ?? ''), reason: String(form.get('reason') ?? '') })
  if (!validLocalId(universityId) || !parsed.success) return { status: 'error', message: 'Check the fields.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null); const row = db.university_requests.find(row => row.id === universityId && row.status === 'pending')
    if (!localStaff(db, me) || !me || !row || row.submitted_by === me.id) return { status: 'error', message: 'That request is not yours to decide.' }
    if (parsed.data.decision === 'approve') db.universities.push({ id: row.id, name: row.name, short_name: row.short_name, city: row.city, country: row.country, student_count: 0, project_count: 0, created_at: row.created_at })
    row.status = parsed.data.decision === 'approve' ? 'approved' : 'rejected'; row.reason = parsed.data.reason; row.reviewed_by = me.id; row.reviewed_at = now()
    db.moderation_actions.push({ id: id('aud'), actor_id: me.id, report_id: null, action: parsed.data.decision === 'approve' ? 'approve_university' : 'reject_university', reason: parsed.data.reason, target_profile_id: row.submitted_by, target_id: row.id, created_at: now() })
    db.notifications.push({ id: id('ntf'), recipient_id: row.submitted_by, actor_id: null, type: 'university_request_decision', body: parsed.data.decision === 'approve' ? 'Your university request was approved.' : 'Your university request was rejected.', is_read: false, created_at: now(), post_id: null, comment_id: null, project_id: null, idea_id: null, event_id: null, opportunity_id: null, conversation_id: null })
    return { status: 'success', message: parsed.data.decision === 'approve' ? 'Approved. The university is now listed publicly.' : 'Rejected. The request is closed and the reason is in the audit log.' }
  })
}
export async function pendingUniversitiesLocal(page = 1, perPage = 25): Promise<{ rows: PendingUniversity[]; total: number; error: null }> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  if (!localStaff(db, me)) return { rows: [], total: 0, error: null }
  const all = db.university_requests.filter(row => row.status === 'pending').sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  const size = Math.max(1, Math.min(100, perPage)); const offset = Math.max(0,page-1)*size
  return { rows: all.slice(offset,offset+size).map(row => { const submitter = db.profiles.find(profile => profile.id === row.submitted_by); return { id: row.id, name: row.name, slug: row.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''), country: row.country, city: row.city, website: row.website, createdAt: row.created_at, submittedBy: submitter ? { id: submitter.id, username: submitter.username, displayName: submitter.display_name } : null } }), total: all.length, error: null }
}
