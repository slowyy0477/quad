import { z } from 'zod'
import {
  OPPORTUNITY_TYPE_VALUES,
  OPPORTUNITY_VISIBILITY_VALUES,
  WORK_MODE_VALUES,
} from '@/features/opportunities/constants'
import { optionalText, requiredText } from '@/lib/form-schemas'

/**
 * Opportunity validation.
 *
 * Every bound mirrors a CHECK in 0013_opportunities_events.sql: title 3..160,
 * organisation 1..160, description 20..10000, compensation <= 120, location <= 160,
 * an https-ish URL, an email-shaped address. The database is what makes them true; this
 * is what makes the refusal legible while the author is still looking at the form.
 *
 * `slug`, `posted_by`, `university_id`, `source`, `save_count` and `moderation_status`
 * are absent because they are not the author's to send. The insert trigger sets all six,
 * and `source` is constrained to `user_submitted` precisely so no other provenance can
 * arrive through a form like this one.
 *
 * The cross-field rules are `refine` calls with an explicit `path` so the message lands
 * under the field that caused it, not at the top of the form.
 */
export const opportunityCreateSchema = z
  .object({
    title: requiredText(3, 160, 'The title'),
    organisation: requiredText(1, 160, 'The organisation'),
    description: requiredText(20, 10000, 'The description'),
    type: z.enum(OPPORTUNITY_TYPE_VALUES as [string, ...string[]]),
    workMode: z.enum(WORK_MODE_VALUES as [string, ...string[]]),
    visibility: z.enum(OPPORTUNITY_VISIBILITY_VALUES as [string, ...string[]]),
    compensation: optionalText(120, 'The compensation'),
    location: optionalText(160, 'The location'),
    applyUrl: optionalText(500, 'The application link'),
    applyEmail: optionalText(254, 'The application email'),
    deadline: optionalText(10, 'The deadline'),
    startsOn: optionalText(10, 'The start date'),
  })
  // `opportunities_has_apply_route`: a listing with no way to apply wastes the reader's
  // time, and the database refuses one, so the form refuses it first.
  .refine((value) => Boolean(value.applyUrl || value.applyEmail), {
    message: 'Add a link or an email address — a listing needs a way to apply',
    path: ['applyUrl'],
  })
  .refine((value) => !value.applyUrl || /^https?:\/\//i.test(value.applyUrl), {
    message: 'Start the address with http:// or https://',
    path: ['applyUrl'],
  })
  .refine((value) => !value.applyEmail || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.applyEmail), {
    message: 'That is not an email address',
    path: ['applyEmail'],
  })
  .refine((value) => !value.deadline || /^\d{4}-\d{2}-\d{2}$/.test(value.deadline), {
    message: 'The deadline must be a date',
    path: ['deadline'],
  })
  .refine((value) => !value.startsOn || /^\d{4}-\d{2}-\d{2}$/.test(value.startsOn), {
    message: 'The start date must be a date',
    path: ['startsOn'],
  })
  // `opportunities_dates_ordered`: a deadline after the start date is not a deadline.
  .refine((value) => !value.deadline || !value.startsOn || value.deadline <= value.startsOn, {
    message: 'The deadline has to be on or before the start date',
    path: ['deadline'],
  })

/**
 * The skills a listing asks for, from repeated checkboxes.
 *
 * Empty is a legitimate answer -- plenty of internships name no particular skill -- and
 * is distinct from a malformed id, which is rejected.
 */
export const opportunitySkillIds = z
  .array(z.string().uuid('That skill could not be identified'))
  .max(20, 'At most 20 skills')

export type OpportunityCreateInput = z.infer<typeof opportunityCreateSchema>
