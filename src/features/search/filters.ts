/** Canonical discovery URLs: q, type=people, university=<id>, department, skill. */
export type DiscoveryParams = Record<string, string | string[] | undefined>

export type PeopleFilters = {
  query: string
  universityId: string | null
  department: string
  skill: string
}

export const PEOPLE_QUERY_MAX = 120
export const DEPARTMENT_QUERY_MAX = 160
export const SKILL_QUERY_MAX = 60

export function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function parsePeopleFilters(params: DiscoveryParams): PeopleFilters {
  return {
    query: (firstValue(params.q) ?? '').trim(),
    universityId: (firstValue(params.university) ?? '').trim() || null,
    department: (firstValue(params.department) ?? '').trim(),
    skill: (firstValue(params.skill) ?? '').trim(),
  }
}

/** Changing a filter/tab starts a new page. Never carry an old cursor into it. */
export function peopleHref(
  filters: PeopleFilters,
  cursor?: string | null,
  basePath: '/search' | '/feed/people' = '/search',
): string {
  const params = new URLSearchParams()
  if (basePath === '/search') params.set('type', 'people')
  if (filters.query) params.set('q', filters.query)
  // An explicit empty university selects all institutions on /feed/people too.
  params.set('university', filters.universityId ?? '')
  if (filters.department) params.set('department', filters.department)
  if (filters.skill) params.set('skill', filters.skill)
  if (cursor) params.set('cursor', cursor)
  return `${basePath}?${params}`
}
