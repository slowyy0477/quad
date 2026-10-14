import { z } from 'zod'
import { displayNameSchema, usernameSchema } from '@/features/auth/schemas'
import { optionalInt, optionalText, optionalUrl, optionalUuid } from '@/lib/form-schemas'

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

export const onboardingSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  universityId,
  degree: optionalText(160, 'Your degree'),
  semester: optionalInt(1, 24, 'Semester must be between 1 and 24'),
  graduationYear: optionalInt(1950, 2100, 'Enter a year between 1950 and 2100'),
  headline: optionalText(120, 'Your headline'),
  bio: optionalText(1000, 'Your bio'),
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

export type OnboardingInput = z.infer<typeof onboardingSchema>
export type ProfileEditInput = z.infer<typeof profileEditSchema>
