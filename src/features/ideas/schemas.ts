import { z } from 'zod'
import { CATEGORY_VALUES, IDEA_STATUS_VALUES, VISIBILITY_VALUES } from '@/features/projects/constants'
import { optionalText, requiredText } from '@/lib/form-schemas'

/**
 * Idea validation.
 *
 * The bounds mirror the CHECK constraints in 0009_ideas.sql: title 5..140,
 * description 20..5000, looking_for <= 1000.
 *
 * `author_id`, `university_id`, the three counters, `moderation_status` and the
 * conversion columns are all absent, and all of them are overwritten or refused by
 * the trigger. `status` is present but the insert trigger forces it to `open`: an
 * idea cannot be born closed, and it cannot be born `converted` because only the
 * conversion function may set that.
 */
export const ideaCreateSchema = z.object({
  title: requiredText(5, 140, 'The title'),
  description: requiredText(20, 5000, 'The pitch'),
  category: z.enum(CATEGORY_VALUES as [string, ...string[]]),
  lookingFor: optionalText(1000, 'What you are looking for'),
  visibility: z.enum(VISIBILITY_VALUES as [string, ...string[]]),
})

/** Editing. `converted` is not offered: only the conversion function sets it. */
export const ideaEditSchema = z.object({
  title: requiredText(5, 140, 'The title'),
  description: requiredText(20, 5000, 'The pitch'),
  category: z.enum(CATEGORY_VALUES as [string, ...string[]]),
  lookingFor: optionalText(1000, 'What you are looking for'),
  status: z.enum(IDEA_STATUS_VALUES as [string, ...string[]]),
  visibility: z.enum(VISIBILITY_VALUES as [string, ...string[]]),
})

/** "I would help build this." The message is what makes the signal actionable. */
export const ideaInterestSchema = z.object({
  message: optionalText(1000, 'Your message'),
  offering: optionalText(200, 'What you would bring'),
})

export type IdeaCreateInput = z.infer<typeof ideaCreateSchema>
export type IdeaEditInput = z.infer<typeof ideaEditSchema>
