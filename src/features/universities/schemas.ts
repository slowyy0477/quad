import { z } from 'zod'
import { optionalUrl } from '@/lib/form-schemas'

/**
 * University validation.
 *
 * Every rule mirrors a constraint in 0003_universities.sql. The database is what
 * makes each one true; these exist so the message a person reads is written for
 * them rather than being a check-constraint name.
 *
 * `status`, `submitted_by`, `slug` and the counters are absent on purpose. A
 * filed institution is `pending` because `app.universities_before_insert` says
 * so, and no field a client can type may decide otherwise.
 */

const name = z
  .string()
  .trim()
  .min(2, 'Enter the institution’s name')
  .max(200, 'Use at most 200 characters')

export const universityRequestSchema = z.object({
  name,
  shortName: z
    .string()
    .trim()
    .max(40, 'Use at most 40 characters')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  city: z
    .string()
    .trim()
    .max(120, 'Use at most 120 characters')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  country: z
    .string()
    .trim()
    .max(80, 'Use at most 80 characters')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  website: optionalUrl(300, 'The website address'),
})

export const claimUniversitySchema = z.object({
  universityId: z.string().uuid('Choose an institution from the list'),
})

export type UniversityRequestInput = z.infer<typeof universityRequestSchema>
