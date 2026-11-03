import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore } from '@/lib/local/db'
import { canReadProfile, localActor, validLocalId } from '@/lib/local/access'
import { fieldErrorsOf, type FormState } from '@/lib/form-state'
import { proposeSkillSchema, proposeInterestSchema, skillLevelSchema } from './schemas'
import type { ProfileSkill, ProfileInterest, SkillOption } from './queries'
import type { LocalCatalogueEntry } from '@/lib/local/domain-tables'

export async function catalogueLocal(table: 'skills' | 'interests', limit: number): Promise<SkillOption[]> {
  const db = await readStore(); const user = await getUser(); const me = localActor(db, user?.id ?? null)
  return (db[table] ?? []).filter(row => row.is_approved || row.created_by === me?.id)
    .sort((a,b) => a.name.localeCompare(b.name)).slice(0, Math.max(0, Math.min(limit, 200)))
    .map(({ id, name, category, usage_count, is_approved }) => ({ id, name, category, usage_count, is_approved }))
}
export async function profileSkillsLocal(profileId: string): Promise<ProfileSkill[]> {
  const db = await readStore(); const user = await getUser(); const me = localActor(db, user?.id ?? null)
  if (!canReadProfile(db, db.profiles.find(row => row.id === profileId), me)) return []
  return (db.profile_skills ?? []).filter(row => row.profile_id === profileId).flatMap(row => {
    const skill = db.skills.find(skill => skill.id === row.skill_id && (skill.is_approved || skill.created_by === me?.id))
    return skill ? [{ skill_id: skill.id, name: skill.name, slug: skill.slug, category: skill.category, level: row.level,
      is_learning: row.is_learning, display_order: row.display_order, endorsement_count: row.endorsement_count, is_approved: skill.is_approved }] : []
  }).sort((a,b) => a.display_order - b.display_order)
}
export async function profileInterestsLocal(profileId: string): Promise<ProfileInterest[]> {
  const db = await readStore(); const user = await getUser(); const me = localActor(db, user?.id ?? null)
  if (!canReadProfile(db, db.profiles.find(row => row.id === profileId), me)) return []
  return (db.profile_interests ?? []).filter(row => row.profile_id === profileId).flatMap(row => {
    const entry = db.interests.find(entry => entry.id === row.interest_id && (entry.is_approved || entry.created_by === me?.id))
    return entry ? [{ interest_id: entry.id, name: entry.name, slug: entry.slug, category: entry.category, is_approved: entry.is_approved }] : []
  })
}
export async function skillWriteLocal(form: FormData, operation: 'proposeSkill' | 'attach' | 'update' | 'removeSkill' | 'proposeInterest' | 'addInterest' | 'removeInterest'): Promise<FormState> {
  const user = await getUser()
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me) return { status: 'error', message: 'Sign in with an active account first.' }
    db.skills ??= []; db.interests ??= []; db.profile_skills ??= []; db.profile_interests ??= []; db.profile_skill_endorsements ??= []
    const isInterest = operation.endsWith('Interest'); const table = isInterest ? 'interests' : 'skills'
    let entry: LocalCatalogueEntry | undefined
    if (operation.startsWith('propose')) {
      const parsed = (isInterest ? proposeInterestSchema : proposeSkillSchema).safeParse({ name: String(form.get('name') ?? ''), category: String(form.get('category') ?? 'other') })
      if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
      const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      if (!slug) return { status: 'error', message: 'Use at least one letter or number.' }
      entry = db[table].find(row => row.slug === slug || row.name.toLowerCase() === parsed.data.name.toLowerCase())
      if (entry && !entry.is_approved && entry.created_by !== me.id) return { status: 'error', message: 'That entry is awaiting review.' }
      if (!entry) { entry = { id: id(isInterest ? 'int' : 'skl'), name: parsed.data.name, category: parsed.data.category, slug, is_approved: false, usage_count: 0, created_by: me.id, created_at: now() }; db[table].push(entry) }
    } else {
      const entryId = String(form.get(isInterest ? 'interestId' : 'skillId') ?? '')
      if (!validLocalId(entryId)) return { status: 'error', message: 'Choose an entry from the list.' }
      entry = db[table].find(row => row.id === entryId)
    }
    if (!entry || (!entry.is_approved && entry.created_by !== me.id)) return { status: 'error', message: 'That entry is not available.' }
    if (isInterest) {
      const existing = db.profile_interests.find(row => row.profile_id === me.id && row.interest_id === entry.id)
      if (operation === 'removeInterest') {
        if (!existing) return { status: 'error', message: 'That interest is not on your profile.' }
        db.profile_interests = db.profile_interests.filter(row => row.id !== existing.id)
      } else {
        if (existing) return { status: 'error', message: 'That interest is already on your profile.' }
        db.profile_interests.push({ id: id('pin'), profile_id: me.id, interest_id: entry.id, created_at: now() })
      }
      entry.usage_count = db.profile_interests.filter(row => row.interest_id === entry.id).length
    } else {
      const existing = db.profile_skills.find(row => row.profile_id === me.id && row.skill_id === entry.id)
      if (operation === 'removeSkill') {
        if (!existing) return { status: 'error', message: 'That skill is not on your profile.' }
        db.profile_skills = db.profile_skills.filter(row => row.id !== existing.id)
        db.profile_skill_endorsements = db.profile_skill_endorsements.filter(row => row.profile_id !== me.id || row.skill_id !== entry.id)
      } else {
        const level = skillLevelSchema.safeParse(operation === 'proposeSkill' ? 'learning' : String(form.get('level') ?? 'learning'))
        if (!level.success) return { status: 'error', fieldErrors: { level: 'Choose a valid level.' } }
        const learning = operation === 'proposeSkill' || form.get('isLearning') !== null
        if (operation === 'update') { if (!existing) return { status: 'error', message: 'That skill is not on your profile.' }; existing.level = level.data; existing.is_learning = learning }
        else { if (existing) return { status: 'error', message: 'That skill is already on your profile.' }; db.profile_skills.push({ id: id('psk'), profile_id: me.id, skill_id: entry.id, level: level.data, is_learning: learning, display_order: db.profile_skills.filter(row => row.profile_id === me.id).length, endorsement_count: 0, created_at: now() }) }
      }
      entry.usage_count = db.profile_skills.filter(row => row.skill_id === entry.id).length
    }
    return { status: 'success', message: 'Saved. Proposed catalogue entries remain private until approved.' }
  })
}
