/**
 * The fixed vocabularies projects and ideas share.
 *
 * These lists mirror the CHECK constraints in migrations 0007 and 0009 exactly. If
 * they drift, the database rejects the write -- which is the right failure, but a
 * confusing one, so the constraint is quoted next to each list rather than left to
 * be rediscovered.
 */

/** `projects.category` / `ideas.category` CHECK, in the same order. */
export const CATEGORIES = [
  { value: 'web', label: 'Web' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'ai_ml', label: 'AI & machine learning' },
  { value: 'data', label: 'Data' },
  { value: 'game', label: 'Games' },
  { value: 'hardware', label: 'Hardware & embedded' },
  { value: 'research', label: 'Research' },
  { value: 'design', label: 'Design' },
  { value: 'social', label: 'Social' },
  { value: 'startup', label: 'Startup' },
  { value: 'coursework', label: 'Coursework' },
  { value: 'other', label: 'Other' },
] as const

export const CATEGORY_VALUES = CATEGORIES.map((c) => c.value)

export function categoryLabel(value: string) {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value
}

/** `projects.status` CHECK. */
export const PROJECT_STATUSES = [
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'abandoned', label: 'Abandoned' },
] as const

export const PROJECT_STATUS_VALUES = PROJECT_STATUSES.map((s) => s.value)

export function projectStatusLabel(value: string) {
  return PROJECT_STATUSES.find((s) => s.value === value)?.label ?? value
}

/** `ideas.status` CHECK. `converted` is not offered: only the conversion function sets it. */
export const IDEA_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'forming', label: 'Forming a team' },
  { value: 'closed', label: 'Closed' },
] as const

export const IDEA_STATUS_VALUES = IDEA_STATUSES.map((s) => s.value)

export function ideaStatusLabel(value: string) {
  if (value === 'converted') return 'Became a project'
  return IDEA_STATUSES.find((s) => s.value === value)?.label ?? value
}

/**
 * The visibility ladder, shared by profiles, projects and ideas.
 *
 * Worth knowing when choosing: a project is clamped to its owner's profile
 * visibility by trigger, so a public project owned by a private profile is stored
 * as private. The forms say so rather than letting the choice be silently ignored.
 */
export const VISIBILITIES = [
  { value: 'public', label: 'Anyone' },
  { value: 'university', label: 'People at my university' },
  { value: 'connections', label: 'People I am connected to' },
  { value: 'private', label: 'Only me' },
] as const

export const VISIBILITY_VALUES = VISIBILITIES.map((v) => v.value)

export function visibilityLabel(value: string) {
  return VISIBILITIES.find((v) => v.value === value)?.label ?? value
}
