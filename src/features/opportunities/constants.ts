/**
 * The opportunity vocabulary.
 *
 * Every list below mirrors a CHECK constraint in 0013_opportunities_events.sql. If they
 * drift the database refuses the write, which is the right failure but a confusing one,
 * so the constraint is quoted next to the list rather than left to be rediscovered.
 */

/** `opportunities.type` CHECK. Nine values, and the board offers all nine. */
export const OPPORTUNITY_TYPES = [
  { value: 'internship', label: 'Internship' },
  { value: 'part_time', label: 'Part-time job' },
  { value: 'full_time', label: 'Full-time job' },
  { value: 'research', label: 'Research placement' },
  { value: 'thesis', label: 'Thesis' },
  { value: 'scholarship', label: 'Scholarship' },
  { value: 'competition', label: 'Competition' },
  { value: 'volunteer', label: 'Volunteering' },
  { value: 'other', label: 'Other' },
] as const

export const OPPORTUNITY_TYPE_VALUES = OPPORTUNITY_TYPES.map((entry) => entry.value)

export function opportunityTypeLabel(value: string) {
  return OPPORTUNITY_TYPES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * `opportunities.work_mode` CHECK.
 *
 * "On site" is modelled as `onsite` in the database and spelled with a space in the
 * interface, because the brief's audience reads it as two words.
 */
export const WORK_MODES = [
  { value: 'onsite', label: 'On site' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'remote', label: 'Remote' },
] as const

export const WORK_MODE_VALUES = WORK_MODES.map((entry) => entry.value)

export function workModeLabel(value: string) {
  return WORK_MODES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * `opportunities.status` CHECK. This is the poster's own status; whether the deadline
 * has passed is a separate fact, held in `deadline`, and both are shown.
 */
export const OPPORTUNITY_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'filled', label: 'Filled' },
] as const

export function opportunityStatusLabel(value: string) {
  return OPPORTUNITY_STATUSES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * The deadline windows the board filters by.
 *
 * A window is "closes within N days", applied on top of "not already past", so the
 * open lens never mixes a closing date with an expired one.
 */
export const DEADLINE_WINDOWS = [
  { value: '7', label: 'Next 7 days', days: 7 },
  { value: '30', label: 'Next 30 days', days: 30 },
  { value: '90', label: 'Next 90 days', days: 90 },
] as const

export function deadlineWindowDays(value: string | undefined): number | null {
  return DEADLINE_WINDOWS.find((entry) => entry.value === value)?.days ?? null
}

/** `opportunities.visibility` CHECK. There are two values, not the four profiles have. */
export const OPPORTUNITY_VISIBILITIES = [
  { value: 'public', label: 'Anyone on Quad' },
  { value: 'university', label: 'People at my university' },
] as const

export const OPPORTUNITY_VISIBILITY_VALUES = OPPORTUNITY_VISIBILITIES.map((entry) => entry.value)
