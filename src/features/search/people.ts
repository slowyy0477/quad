import 'server-only'

import { canReadProfile, localActor } from '@/lib/local/access'
import { readStore, type LocalProfile, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { createClient, getUser } from '@/lib/supabase/server'
import type { ProfileSummary } from '@/features/profiles/queries'
import {
  DEPARTMENT_QUERY_MAX, PEOPLE_QUERY_MAX, SKILL_QUERY_MAX, type PeopleFilters,
} from './filters'
import {
  belowKeyset, boundedPageSize, decodeKeysetCursor, keysetPage, keysetScope,
  newestFirst, validDiscoveryId,
} from './paging'

export type DiscoverySkill = {
  id: string
  name: string
  /** The person's own claim, never measured or inferred proficiency. */
  level: string
  is_learning: boolean
}

export type DiscoveryUniversity = { id: string; name: string; short_name: string | null }

export type DiscoveryPerson = ProfileSummary & {
  created_at: string
  university: DiscoveryUniversity | null
  department: string | null
  skills: DiscoverySkill[]
}

export type PeoplePage = {
  people: DiscoveryPerson[] | null
  nextCursor: string | null
  error: string | null
}

type PeopleRow = ProfileSummary & {
  created_at: string
  university_id: string | null
  university_name: string | null
  university_short_name: string | null
  department: string | null
  skills: DiscoverySkill[]
}

const MAX_SKILLS_SHOWN = 5

function literalMatch(value: string | null | undefined, term: string): boolean {
  return !term || Boolean(value?.toLowerCase().includes(term.toLowerCase()))
}

function localSkills(db: Tables, profile: LocalProfile, viewer: LocalProfile, term: string) {
  return db.profile_skills.filter((claim) => claim.profile_id === profile.id).flatMap((claim) => {
    const skill = db.skills.find((entry) => entry.id === claim.skill_id &&
      (entry.is_approved || entry.created_by === viewer.id))
    return skill ? [{
      id: skill.id, name: skill.name, level: claim.level, is_learning: claim.is_learning,
      order: claim.display_order, at: claim.created_at,
    }] : []
  }).sort((a, b) =>
    Number(literalMatch(b.name, term)) - Number(literalMatch(a.name, term)) ||
    a.order - b.order || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** Count-free, literal search with recency keysets, identical to forward 0028. */
export async function discoverPeople({
  query = '', universityId = null, department = '', skill = '', cursor,
  limit, excludeSelf = false,
}: Partial<PeopleFilters> & {
  cursor?: string | string[]
  limit?: number
  excludeSelf?: boolean
} = {}): Promise<PeoplePage> {
  const filters: PeopleFilters = {
    query: query.trim(), universityId: universityId?.trim() || null,
    department: department.trim(), skill: skill.trim(),
  }
  const local = isLocalMode()
  if (filters.query.length > PEOPLE_QUERY_MAX || filters.department.length > DEPARTMENT_QUERY_MAX ||
    filters.skill.length > SKILL_QUERY_MAX) {
    return { people: null, nextCursor: null, error: 'Use a shorter name, department or skill filter.' }
  }
  if (filters.universityId && !validDiscoveryId(filters.universityId, local)) {
    return { people: null, nextCursor: null, error: 'Choose an institution from the directory.' }
  }
  if (filters.query.length === 1) {
    return { people: [], nextCursor: null, error: 'Use at least two characters for a name search, or leave it empty to browse.' }
  }
  const size = boundedPageSize(limit)
  const scope = keysetScope([
    'people', filters.query.toLowerCase(), filters.universityId,
    filters.department.toLowerCase(), filters.skill.toLowerCase(), excludeSelf,
  ])
  const after = decodeKeysetCursor(cursor, scope, local)

  try {
    const user = await getUser()
    if (!user) return { people: null, nextCursor: null, error: 'Sign in to discover people.' }

    if (local) {
      const db = await readStore()
      const viewer = localActor(db, user.id)
      if (!viewer) return { people: null, nextCursor: null, error: 'Sign in with an active account to discover people.' }
      const rows = db.profiles.filter((profile) =>
        profile.searchable && (!excludeSelf || profile.id !== viewer.id) &&
        canReadProfile(db, profile, viewer) &&
        (!filters.universityId || profile.university_id === filters.universityId) &&
        literalMatch(profile.department, filters.department) &&
        (!filters.query || literalMatch(profile.display_name, filters.query) ||
          literalMatch(profile.username, filters.query)) &&
        (!after || belowKeyset(profile, after)),
      ).flatMap((profile) => {
        const claims = localSkills(db, profile, viewer, filters.skill)
        if (filters.skill && !claims.some((claim) => literalMatch(claim.name, filters.skill))) return []
        const university = db.universities.find((row) => row.id === profile.university_id)
        return [{
          id: profile.id, username: profile.username, display_name: profile.display_name,
          avatar_url: profile.avatar_url, headline: profile.headline ?? null,
          created_at: profile.created_at, department: profile.department,
          university: university ? {
            id: university.id, name: university.name, short_name: university.short_name,
          } : null,
          skills: claims.slice(0, MAX_SKILLS_SHOWN).map(({ id, name, level, is_learning }) =>
            ({ id, name, level, is_learning })),
        }]
      }).sort(newestFirst).slice(0, size + 1)
      const page = keysetPage(rows, size, scope)
      return { people: page.items, nextCursor: page.nextCursor, error: null }
    }

    const supabase = await createClient()
    // Bound RPC values, not string-built .or filters. SQL escapes LIKE metacharacters.
    const { data, error } = await supabase.rpc('people_discovery', {
      p_query: filters.query, p_university_id: filters.universityId,
      p_department: filters.department, p_skill: filters.skill,
      p_after_created_at: after?.createdAt ?? null, p_after_id: after?.id ?? null,
      p_limit: size, p_exclude_self: excludeSelf,
    })
    if (error) {
      console.error('[search:people]', error.code)
      return { people: null, nextCursor: null, error: 'People could not be loaded. Please try again.' }
    }
    const rows = (data ?? []) as unknown as PeopleRow[]
    const page = keysetPage(rows, size, scope)
    return {
      people: page.items.map((row) => ({
        id: row.id, username: row.username, display_name: row.display_name,
        avatar_url: row.avatar_url, headline: row.headline, created_at: row.created_at,
        department: row.department,
        university: row.university_id && row.university_name ? {
          id: row.university_id, name: row.university_name, short_name: row.university_short_name,
        } : null,
        skills: (row.skills ?? []).slice(0, MAX_SKILLS_SHOWN).map(({ id, name, level, is_learning }) =>
          ({ id, name, level, is_learning })),
      })),
      nextCursor: page.nextCursor,
      error: null,
    }
  } catch {
    console.error('[search:people] read failed')
    return { people: null, nextCursor: null, error: 'People could not be loaded. Please try again.' }
  }
}

/** Reference catalogue only: no student/project/usage counts or profile-derived facets. */
export async function listDiscoveryUniversities(limit = 200): Promise<{
  universities: DiscoveryUniversity[]
  hasMore: boolean
  error: string | null
}> {
  const size = boundedPageSize(limit, 200, 200)
  try {
    if (isLocalMode()) {
      const db = await readStore()
      const rows = [...db.universities].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      return {
        universities: rows.slice(0, size).map(({ id, name, short_name }) => ({ id, name, short_name })),
        hasMore: rows.length > size, error: null,
      }
    }
    const supabase = await createClient()
    const { data, error } = await supabase.from('universities')
      .select('id, name, short_name').order('name').order('id').limit(size + 1)
      .returns<DiscoveryUniversity[]>()
    if (error) return { universities: [], hasMore: false, error: 'The institution picker could not be loaded. You can still use a saved discovery link.' }
    return { universities: (data ?? []).slice(0, size), hasMore: (data ?? []).length > size, error: null }
  } catch {
    return { universities: [], hasMore: false, error: 'The institution picker could not be loaded. You can still use a saved discovery link.' }
  }
}
