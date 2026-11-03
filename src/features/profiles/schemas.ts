import { z } from 'zod'
import { displayNameSchema, usernameSchema } from '@/features/auth/schemas'
import { optionalInt, optionalText, optionalUrl, optionalUuid } from '@/lib/form-schemas'
import { RESERVED_BRAND_USERNAMES } from '@/lib/brand'
import { validLocalId } from '@/lib/local/access'

/**
 * Profile validation.
 *
 * Every rule mirrors a constraint in 0004_profiles.sql. The database is what makes
 * the rule true; these exist so the message a person reads is written for them
 * rather than being a Postgres check-constraint name.
 *
 * `usernameSchema` is imported rather than redefined. Two copies of a regular
 * expression is two things to keep in step, and the one in the auth module already
 * carries the note explaining why uniqueness is not checked here. The `optional*`
 * helpers come from lib/form-schemas for the same reason.
 */

const universityId = optionalUuid('Choose a university from the list')
// Unlike older optional fields, omission must not clear an existing affiliation.
// A rendered empty option is an explicit clear; an absent field is a legacy client.
const departmentId = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? null : value,
  z.string().trim().uuid('Choose a department from the list').nullable().optional(),
)

export const onboardingSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  universityId,
  departmentId,
  degree: optionalText(160, 'Your degree'),
  semester: optionalInt(1, 24, 'Semester must be between 1 and 24'),
  graduationYear: optionalInt(1950, 2100, 'Enter a year between 1950 and 2100'),
  headline: optionalText(120, 'Your headline'),
  bio: optionalText(1000, 'Your bio'),
  // Older clients omit this field. Preserve their existing privacy setting;
  // newly created local profiles are private, and the new form defaults private.
  visibility: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.enum(['public', 'university', 'connections', 'private'], {
      message: 'Choose who can see your profile',
    }).optional(),
  ),
})

/**
 * Editing an existing profile.
 *
 * Username is absent on purpose. The database rate-limits a username change to
 * once every 30 days, which needs its own form and its own explanation of the
 * consequence rather than being a field someone edits by accident while fixing
 * their bio.
 */
export const profileEditSchema = z.object({
  displayName: displayNameSchema,
  universityId,
  departmentId,
  degree: optionalText(160, 'Your degree'),
  semester: optionalInt(1, 24, 'Semester must be between 1 and 24'),
  graduationYear: optionalInt(1950, 2100, 'Enter a year between 1950 and 2100'),
  headline: optionalText(120, 'Your headline'),
  bio: optionalText(1000, 'Your bio'),
  location: optionalText(120, 'Your location'),
  website: optionalUrl(300, 'Your website'),
  githubUsername: optionalText(39, 'Your GitHub username').refine(
    (value) => value === undefined || /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value),
    { message: 'That is not a valid GitHub username' },
  ),
  visibility: z.enum(['public', 'university', 'connections', 'private']),
})

// The foundation reservations in 0004_profiles.sql, plus the current brand.
// Local mode has no reserved_usernames table or username-validation trigger.
const reservedLocalUsernames = new Set<string>([
  'admin', 'administrator', 'support', 'help', 'moderator', 'mod',
  'system', 'official', 'root', 'staff', 'team', 'security', 'billing',
  'noreply', 'no_reply', 'postmaster', 'webmaster', 'abuse', 'legal', 'privacy',
  'quad', 'quadapp', 'api', 'auth', 'login', 'signup', 'logout', 'onboarding',
  'settings', 'dashboard', 'explore', 'search', 'messages', 'notifications',
  'projects', 'project', 'universities', 'university', 'opportunities', 'events',
  'about', 'contact', 'terms', 'guidelines', 'sitemap', 'robots', 'static',
  '_next', 'me', 'new', 'edit', 'null', 'undefined', 'anonymous',
  ...RESERVED_BRAND_USERNAMES,
])

const localUniversityId = optionalText(128, 'University ID').refine(
  (value) => value === undefined || validLocalId(value),
  { message: 'Choose a university from the list' },
)
const localDepartmentId = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? null : value,
  z.string().trim().max(128, 'Choose a department from the list')
    .refine(validLocalId, 'Choose a department from the list').nullable().optional(),
)

// Only local IDs differ from the cloud schemas. Membership and username
// uniqueness are checked again against the locked transaction snapshot.
export const localOnboardingSchema = onboardingSchema.extend({
  universityId: localUniversityId,
  departmentId: localDepartmentId,
  username: usernameSchema
    .toLowerCase()
    .refine((value) => !reservedLocalUsernames.has(value), 'That username is reserved.')
    .refine((value) => !/^\d+$/.test(value), 'A username cannot be only digits.'),
})

export const localProfileEditSchema = profileEditSchema.extend({
  universityId: localUniversityId,
  departmentId: localDepartmentId,
})

export type OnboardingInput = z.infer<typeof onboardingSchema>
export type ProfileEditInput = z.infer<typeof profileEditSchema>
