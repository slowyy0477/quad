import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore, type LocalProfile, type LocalReport, type Tables } from '@/lib/local/db'
import { canReadContent, canReadProfile, localActor, validLocalId, blockedPair, contentActive } from '@/lib/local/access'
import { messageReportTargetLocal } from '@/features/messages/local-access'
import type { FormState } from '@/lib/form-state'
import { moderationDecisionSchema, reportSchema, type ReportKind } from './schemas'
import type { PersonRef, QueueReport, ModerationActionRow, ReportTarget } from './queries'

export function staffLocal(db: Tables, viewer: LocalProfile | null, role: 'admin' | 'moderator' = 'moderator'): boolean {
  return Boolean(viewer && localActor(db, viewer.user_id) && db.user_roles.some(row => row.user_id === viewer.user_id && (row.role === 'admin' || (role === 'moderator' && row.role === 'moderator'))))
}
function person(db: Tables, profileId: string | null): PersonRef | null {
  const row = db.profiles.find(row => row.id === profileId)
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null
}
function reportReference(row: LocalReport): { kind: ReportKind; targetId: string } | null {
  for (const [kind, targetId] of [['post', row.post_id], ['comment', row.comment_id], ['project', row.project_id], ['idea', row.idea_id], ['message', row.message_id], ['profile', row.reported_profile_id], ['event', row.event_id], ['opportunity', row.opportunity_id]] as const) if (targetId) return { kind, targetId }
  return null
}
function targetOwner(db: Tables, kind: ReportKind, targetId: string): string | null {
  switch (kind) {
    case 'post': return db.posts.find(row => row.id === targetId)?.author_id ?? null
    case 'comment': return db.comments.find(row => row.id === targetId)?.author_id ?? null
    case 'project': return db.projects.find(row => row.id === targetId)?.owner_id ?? null
    case 'idea': return db.ideas.find(row => row.id === targetId)?.author_id ?? null
    case 'message': return db.messages.find(row => row.id === targetId)?.author_id ?? null
    case 'profile': return db.profiles.find(row => row.id === targetId)?.id ?? null
    case 'event': return db.events.find(row => row.id === targetId)?.created_by ?? null
    case 'opportunity': return db.opportunities.find(row => row.id === targetId)?.posted_by ?? null
  }
}
function targetVisible(db: Tables, me: LocalProfile, kind: ReportKind, targetId: string): boolean {
  const ownerId = targetOwner(db, kind, targetId)
  if (!ownerId || blockedPair(db, me.id, ownerId) || !contentActive(db, kind, targetId)) return false
  if (kind === 'profile') return canReadProfile(db, db.profiles.find(row => row.id === targetId), me)
  if (kind === 'message') return Boolean(messageReportTargetLocal(db, targetId, me))
  if (kind === 'comment') { const comment = db.comments.find(row => row.id === targetId); const post = db.posts.find(row => row.id === comment?.post_id); return Boolean(comment && !comment.deleted_at && post && post.moderation_status === 'active' && canReadContent(db, post, post.author_id, me, 'post')) }
  const row = kind === 'post' ? db.posts.find(row => row.id === targetId)
    : kind === 'project' ? db.projects.find(row => row.id === targetId)
    : kind === 'event' ? db.events.find(row => row.id === targetId)
    : kind === 'opportunity' ? db.opportunities.find(row => row.id === targetId)
    : db.ideas.find(row => row.id === targetId)
  return Boolean(row && canReadContent(db, row, ownerId, me, kind) && (kind !== 'post' || db.posts.find(row => row.id === targetId)?.moderation_status === 'active'))
}
function targetView(db: Tables, kind: ReportKind, targetId: string): ReportTarget | null {
  const moderationStatus = db.content_moderation.find(row => row.kind === kind && row.target_id === targetId)?.status ?? 'active'
  const author = person(db, targetOwner(db, kind, targetId))
  switch (kind) {
    case 'post': { const row = db.posts.find(row => row.id === targetId); return row ? { kind, id: row.id, body: row.body, createdAt: row.created_at, moderationStatus: row.moderation_status, author } : null }
    case 'comment': { const row = db.comments.find(row => row.id === targetId); return row ? { kind, id: row.id, body: row.body, createdAt: row.created_at, moderationStatus, author, postId: row.post_id } : null }
    case 'project': { const row = db.projects.find(row => row.id === targetId); return row ? { kind, id: row.id, title: row.title, tagline: row.purpose, slug: row.slug, moderationStatus, author } : null }
    case 'idea': { const row = db.ideas.find(row => row.id === targetId); return row ? { kind, id: row.id, title: row.title, description: row.description, moderationStatus, author } : null }
    case 'message': { const row = db.messages.find(row => row.id === targetId); return row ? { kind, id: row.id, body: row.body, createdAt: row.created_at, moderationStatus } : null }
    case 'profile': return author ? { kind, id: targetId, person: author, status: db.profile_account_states.find(row => row.profile_id === targetId)?.status ?? 'active' } : null
    case 'event': { const row = db.events.find(row => row.id === targetId); return row ? { kind, id: row.id, title: row.title, description: row.description, moderationStatus, author } : null }
    case 'opportunity': { const row = db.opportunities.find(row => row.id === targetId); return row ? { kind, id: row.id, title: row.title, description: row.description, moderationStatus, author } : null }
  }
}
export async function reportLocal(form: FormData): Promise<FormState> {
  const targetId = String(form.get('targetId') ?? '')
  const parsed = reportSchema.omit({ targetId: true }).safeParse({ kind: String(form.get('kind') ?? ''), reason: String(form.get('reason') ?? ''), detail: String(form.get('detail') ?? '') })
  if (!validLocalId(targetId) || !parsed.success) return { status: 'error', message: 'Check the fields.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me || !targetVisible(db, me, parsed.data.kind, targetId)) return { status: 'error', message: 'You can only report something you can see.' }
    if (db.reports.some(row => row.reporter_id === me.id && row.status === 'open' && reportReference(row)?.kind === parsed.data.kind && reportReference(row)?.targetId === targetId)) return { status: 'error', message: 'You have already reported this.' }
    db.reports.push({ id: id('rpt'), reporter_id: me.id, reason: parsed.data.reason, detail: parsed.data.detail ?? null, status: 'open', created_at: now(), post_id: parsed.data.kind === 'post' ? targetId : null, comment_id: parsed.data.kind === 'comment' ? targetId : null, project_id: parsed.data.kind === 'project' ? targetId : null, idea_id: parsed.data.kind === 'idea' ? targetId : null, message_id: parsed.data.kind === 'message' ? targetId : null, reported_profile_id: parsed.data.kind === 'profile' ? targetId : null, event_id: parsed.data.kind === 'event' ? targetId : null, opportunity_id: parsed.data.kind === 'opportunity' ? targetId : null })
    return { status: 'success', message: 'Thank you. A moderator will review it.' }
  })
}
export async function decisionLocal(form: FormData): Promise<FormState> {
  const reportId = String(form.get('reportId') ?? '')
  const parsed = moderationDecisionSchema.omit({ reportId: true }).safeParse({ action: String(form.get('action') ?? ''), reason: String(form.get('reason') ?? ''), days: form.get('days') ?? 7 })
  if (!validLocalId(reportId) || !parsed.success) return { status: 'error', message: 'Check the fields.' }
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null); const report = db.reports.find(row => row.id === reportId); const ref = report && reportReference(report)
    if (!staffLocal(db, me) || !me || !report || !ref || (report.status !== 'open' && parsed.data.action !== 'restore_content')) return { status: 'error', message: 'That decision is not available.' }
    const ownerId = targetOwner(db, ref.kind, ref.targetId); const owner = db.profiles.find(row => row.id === ownerId)
    if (!owner || me.id === owner.id || (staffLocal(db, owner, 'admin') && !staffLocal(db, me, 'admin'))) return { status: 'error', message: 'You cannot decide this report.' }
    const action = parsed.data.action
    if (['hide_content','remove_content','restore_content'].includes(action)) {
      if (ref.kind === 'profile') return { status: 'error', message: 'Choose an account action for a profile report.' }
      const status = action === 'restore_content' ? 'active' : action === 'remove_content' ? 'removed' : 'hidden'
      const state = db.content_moderation.find(row => row.kind === ref.kind && row.target_id === ref.targetId)
      if (state) state.status = status; else db.content_moderation.push({ id: id('mod'), kind: ref.kind, target_id: ref.targetId, status })
      const post = ref.kind === 'post' ? db.posts.find(row => row.id === ref.targetId) : null
      if (post) post.moderation_status = status === 'active' ? 'active' : 'hidden'
    }
    if (action === 'warn_user' || action === 'suspend_user') {
      let state = db.profile_account_states.find(row => row.profile_id === owner.id)
      if (!state) { state = { id: id('sta'), profile_id: owner.id, status: 'active', suspended_until: null, warning_count: 0 }; db.profile_account_states.push(state) }
      if (action === 'warn_user') state.warning_count += 1
      else {
        state.status = 'suspended'; state.suspended_until = new Date(Date.now() + parsed.data.days * 86400000).toISOString()
        // Temporary suspension must not set or clear the permanent disabled_at flag.
        db.sessions = db.sessions.filter(row => row.user_id !== owner.user_id)
      }
    }
    db.moderation_actions.push({ id: id('aud'), actor_id: me.id, report_id: report.id, action, reason: parsed.data.reason, target_profile_id: owner.id, target_id: ref.targetId, created_at: now() })
    report.status = action === 'dismiss_report' ? 'dismissed' : 'actioned'
    for (const recipient of new Set([report.reporter_id, owner.id])) db.notifications.push({ id: id('ntf'), recipient_id: recipient, actor_id: null, type: 'moderation_decision', body: 'A moderator has reviewed a report concerning your account or content.', is_read: false, created_at: now(), post_id: null, comment_id: null, project_id: null, idea_id: null, event_id: null, opportunity_id: null, conversation_id: null })
    return { status: 'success', message: 'Decision recorded.' }
  })
}
export async function reportsLocal(page = 1, perPage = 25): Promise<{ rows: QueueReport[]; total: number; error: null }> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  if (!staffLocal(db, me)) return { rows: [], total: 0, error: null }
  const all = db.reports.filter(row => row.status === 'open').sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).flatMap(row => {
    const ref = reportReference(row); const target = ref && targetView(db, ref.kind, ref.targetId)
    return ref && target ? [{ id: row.id, kind: ref.kind, reason: row.reason, detail: row.detail, createdAt: row.created_at, reporter: person(db, row.reporter_id), reported: ref.kind === 'message' ? null : person(db, targetOwner(db, ref.kind, ref.targetId)), target }] : []
  })
  const size = Math.max(1, Math.min(100, perPage)); return { rows: all.slice(Math.max(0,page-1)*size, Math.max(0,page-1)*size+size), total: all.length, error: null }
}
export async function auditLocal(page = 1, perPage = 25): Promise<{ rows: ModerationActionRow[]; total: number; error: null }> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  if (!staffLocal(db, me)) return { rows: [], total: 0, error: null }
  const all = [...db.moderation_actions].sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  const size = Math.max(1, Math.min(100, perPage)); const rows = all.slice(Math.max(0,page-1)*size, Math.max(0,page-1)*size+size).map(row => ({ id: row.id, action: row.action, reason: row.reason, createdAt: row.created_at, actor: person(db, row.actor_id), target: person(db, row.target_profile_id), reportId: row.report_id, university: null, supersedesId: null, subject: 'reported content or account' }))
  return { rows, total: all.length, error: null }
}
