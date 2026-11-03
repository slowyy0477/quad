import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore } from '@/lib/local/db'
import { canReadContent, canReadProfile, canManageLocalProject, localActor, validLocalId, blockedPair } from '@/lib/local/access'
import type { FormState } from '@/lib/form-state'
import type { ProjectApplicationRow } from './queries'
import { projectJoinSchema } from './schemas'

export async function projectParticipationLocal(form: FormData, operation: 'star' | 'apply' | 'withdraw' | 'review'): Promise<FormState> {
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    const application = db.project_applications.find(row => row.id === String(form.get('applicationId') ?? ''))
    const projectId = operation === 'review' ? application?.project_id : String(form.get('projectId') ?? '')
    const project = db.projects.find(row => row.id === projectId)
    if (!me || !projectId || !validLocalId(projectId) || !project || !canReadContent(db, project, project.owner_id, me, 'project')) return { status: 'error', message: 'That action is not available.' }
    const slug = String(form.get('slug') ?? '')
    if (slug && slug !== project.slug) return { status: 'error', message: 'That action is not available.' }
    if (operation === 'star') {
      const starred = String(form.get('starred') ?? '')
      if (!['true','false'].includes(starred)) return { status: 'error', message: 'Check the fields.' }
      if (starred === 'true') db.project_stars = db.project_stars.filter(row => row.project_id !== project.id || row.profile_id !== me.id)
      else if (!db.project_stars.some(row => row.project_id === project.id && row.profile_id === me.id)) db.project_stars.push({ id: id('str'), project_id: project.id, profile_id: me.id, created_at: now() })
      return { status: 'success', message: 'Saved.' }
    }
    if (operation === 'apply') {
      const parsed = projectJoinSchema.safeParse({ message: String(form.get('message') ?? ''), desiredRole: String(form.get('desiredRole') ?? '') })
      if (!parsed.success) return { status: 'error', message: 'Check the fields.' }
      if (!project.is_seeking_members || ['archived','completed'].includes(project.status) || project.owner_id === me.id || db.project_members.some(row => row.project_id === project.id && row.profile_id === me.id)) return { status: 'error', message: 'This project is not accepting your application.' }
      const old = db.project_applications.find(row => row.project_id === project.id && row.applicant_id === me.id)
      if (old?.status === 'pending' || old?.status === 'accepted') return { status: 'error', message: 'You have already applied.' }
      if (old) db.project_applications = db.project_applications.filter(row => row.id !== old.id)
      db.project_applications.push({ id: id('app'), project_id: project.id, applicant_id: me.id, message: parsed.data.message ?? null, desired_role: parsed.data.desiredRole ?? null, status: 'pending', reviewed_by: null, reviewed_at: null, created_at: now() })
      return { status: 'success', message: 'Your request was sent.' }
    }
    if (operation === 'withdraw') {
      const own = db.project_applications.find(row => row.project_id === project.id && row.applicant_id === me.id && row.status === 'pending')
      if (!own) return { status: 'error', message: 'That action is not available.' }
      own.status = 'withdrawn'; return { status: 'success', message: 'Withdrawn.' }
    }
    const decision = String(form.get('decision') ?? '')
    if (!application || application.status !== 'pending' || !['accepted','rejected'].includes(decision) || !canManageLocalProject(db, project.id, me) || blockedPair(db, application.applicant_id, me.id) || blockedPair(db, application.applicant_id, project.owner_id)) return { status: 'error', message: 'That action is not available.' }
    if (decision === 'accepted') {
      if (project.team_size_target && db.project_members.filter(row => row.project_id === project.id).length >= project.team_size_target) return { status: 'error', message: 'This project has reached its team size.' }
      if (!db.project_members.some(row => row.project_id === project.id && row.profile_id === application.applicant_id)) db.project_members.push({ id: id('mem'), project_id: project.id, profile_id: application.applicant_id, role: 'member', created_at: now() })
      project.member_count = db.project_members.filter(row => row.project_id === project.id).length
    }
    application.status = decision as 'accepted' | 'rejected'; application.reviewed_by = me.id; application.reviewed_at = now()
    return { status: 'success', message: 'Saved.' }
  })
}
export async function pendingApplicationsLocal(projectId: string): Promise<ProjectApplicationRow[]> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  const project = db.projects.find(row => row.id === projectId)
  if (!me || !project || !canReadContent(db, project, project.owner_id, me, 'project')) return []
  return db.project_applications.filter(row => row.project_id === projectId && row.status === 'pending' && (row.applicant_id === me.id || canManageLocalProject(db, projectId, me)) && !blockedPair(db, me.id, row.applicant_id)).map(row => {
    const profile = db.profiles.find(profile => profile.id === row.applicant_id)
    return { id: row.id, message: row.message, desired_role: row.desired_role, status: row.status, created_at: row.created_at, applicant: profile && canReadProfile(db, profile, me) ? { id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url, headline: profile.department } : null }
  })
}
export async function starredLocal(projectId: string): Promise<boolean> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  const project = db.projects.find(row => row.id === projectId)
  return Boolean(me && project && canReadContent(db, project, project.owner_id, me, 'project') && db.project_stars.some(row => row.project_id === projectId && row.profile_id === me.id))
}
