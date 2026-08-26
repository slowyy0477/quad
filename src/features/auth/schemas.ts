import { z } from 'zod'

/**
 * Auth validation.
 *
 * These schemas run in the browser for immediate feedback and again in the Server
 * Action before anything is written. The second run is the one that counts: the
 * first is a courtesy that anyone can skip with curl.
 *
 * Every rule here mirrors a constraint that also exists in Postgres, and the
 * mirroring is deliberate rather than duplicated by accident. Client validation
 * gives a good message; the database constraint is what makes the rule true. The
 * username pattern in particular is copied from the check constraint in
 * 0004_profiles.sql -- if one changes, both must.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .max(254, 'That email address is too long')
  .email('That does not look like an email address')
  .toLowerCase()

/**
 * Password rules.
 *
 * A length floor and nothing else. Composition rules ("one uppercase, one digit,
 * one symbol") measurably push people towards `Password1!` and towards writing it
 * down; length is the property that actually costs an attacker something. Twelve
 * characters is above Supabase's default of six, which is too low to leave alone.
 *
 * The upper bound exists because bcrypt silently truncates past 72 bytes, and a
 * silently truncated password is worse than a rejected one.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters — a short phrase works well')
  .max(72, 'Use at most 72 characters')

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter the name you want shown on your profile')
  .max(80, 'Use at most 80 characters')

/**
 * Username.
 *
 * Mirrors `^[A-Za-z0-9][A-Za-z0-9_]{1,28}[A-Za-z0-9]$` in the profiles table:
 * 3–30 characters, alphanumeric at both ends, underscores allowed inside.
 *
 * Uniqueness is *not* checked here, and cannot usefully be. A "that name is free"
 * answer is only true until the next request; two people submitting the same
 * handle at the same moment both pass validation and only one can win. The unique
 * index on `lower(username)` is what decides, and the action reads its error.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Usernames are at least 3 characters')
  .max(30, 'Usernames are at most 30 characters')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_]{1,28}[A-Za-z0-9]$/,
    'Letters, numbers and underscores, starting and ending with a letter or number',
  )

export const signInSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing password predates the current rules, and
  // rejecting it at the sign-in form would lock people out of their own accounts
  // with a validation error instead of letting them in to change it.
  password: z.string().min(1, 'Enter your password'),
})

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  // Checkbox values arrive as 'on' or absent, never as a boolean.
  acceptTerms: z.literal('on', { message: 'Please accept the terms to continue' }),
})

export const resetRequestSchema = z.object({ email: emailSchema })

export const newPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string().min(1, 'Repeat your new password'),
  })
  .refine((value) => value.password === value.confirm, {
    message: 'Those passwords do not match',
    path: ['confirm'],
  })

export type SignInInput = z.infer<typeof signInSchema>
export type SignUpInput = z.infer<typeof signUpSchema>
