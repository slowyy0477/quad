import { z } from 'zod'

/**
 * Field helpers shared by every form in the app.
 *
 * These exist because of one fact about HTML: a form has no way to say "absent".
 * An untouched text input, number input or select posts an empty string, so every
 * optional field arrives as `''` and has to be turned into something the database
 * can store as NULL. Storing `''` instead would make "cleared this" and "never
 * filled it in" indistinguishable, and every read would have to check both.
 *
 * So: empty becomes `undefined` here, once, and each action turns `undefined` into
 * NULL when it builds the row.
 */

/** An optional bounded text field. */
export const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is at most ${max} characters`)
    .optional()
    .transform((value) => (value === '' ? undefined : value))

/** A required bounded text field, with both bounds named in the message. */
export const requiredText = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} needs at least ${min} characters`)
    .max(max, `${label} is at most ${max} characters`)

/** An optional integer from `<input type="number">`, which also posts ''. */
export const optionalInt = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : Number(value)))
    .refine(
      (value) => value === undefined || (Number.isInteger(value) && value >= min && value <= max),
      { message },
    )

/**
 * An optional uuid from a `<select>`.
 *
 * The empty option is a legitimate answer -- "not saying", "none of these" -- and is
 * not the same as an invalid id, which is rejected.
 */
export const optionalUuid = (message = 'Choose an option from the list') =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : value))
    .refine((value) => value === undefined || z.string().uuid().safeParse(value).success, {
      message,
    })

/**
 * An optional absolute http(s) URL.
 *
 * The scheme check is not cosmetic. The database constraints on `repo_url`,
 * `demo_url` and `website` are `~* '^https?://'`, and a value like
 * `javascript:alert(1)` in an href is an XSS vector -- rejecting anything that is
 * not http or https at the edge means no renderer has to remember to re-check.
 */
export const optionalUrl = (max: number, label: string) =>
  optionalText(max, label).refine((value) => value === undefined || /^https?:\/\//i.test(value), {
    message: 'Start the address with http:// or https://',
  })

/** An optional `<input type="date">`, which posts '' or an ISO yyyy-mm-dd. */
export const optionalDate = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : value))
    .refine((value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value), {
      message: `${label} must be a date`,
    })
