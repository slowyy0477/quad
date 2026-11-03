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
 * A 15-character phrase, without uppercase/digit/symbol composition rules.
 * Reject trivial repetition, whitespace-only strings and a small common-password
 * denylist. This is not a comprehensive breached-password screening service.
 * Local scrypt does not truncate passwords; the 128-character ceiling bounds
 * new input. Sign-in has a separate compatibility policy for existing accounts.
 */
export const passwordSchema = z
  .string()
  .min(15, 'Use at least 15 characters — a short phrase works well')
  .refine((value) => Array.from(value).length >= 15, 'Use at least 15 characters — a short phrase works well')
  .max(128, 'Use at most 128 characters')
  .refine((value) => value.trim().length > 0 && !/^(.)\1+$/u.test(value), 'Use a phrase that is not a repeated character')
  .refine((value) => !['passwordpassword', 'password123456789', '123456789012345', 'qwertyuiopasdfgh', 'letmeinletmein12'].includes(value.toLowerCase()), 'Choose a less common password')

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
  password: z.string().min(1, 'Enter your password').max(1024, 'That password is too long'),
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

export const changePasswordSchema = newPasswordSchema
  .safeExtend({ currentPassword: signInSchema.shape.password })
  .refine((value) => value.currentPassword !== value.password, {
    message: 'Choose a password different from your current password',
    path: ['password'],
  })

/** Supabase's bcrypt adapter must not silently truncate a long UTF-8 password. */
export const cloudPasswordSchema = passwordSchema.refine(
  (value) => new TextEncoder().encode(value).length <= 72,
  'For this account service, use at most 72 UTF-8 bytes (fewer characters for emoji)',
)

export const cloudSignUpSchema = signUpSchema.safeExtend({ password: cloudPasswordSchema })

export type SignInInput = z.infer<typeof signInSchema>
export type SignUpInput = z.infer<typeof signUpSchema>
