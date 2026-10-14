import { z } from 'zod'
import {
  CATEGORY_VALUES,
  PROJECT_STATUS_VALUES,
  VISIBILITY_VALUES,
} from '@/features/projects/constants'
import {
  optionalDate,
  optionalInt,
  optionalText,
  optionalUrl,
  requiredText,
} from '@/lib/form-schemas'

/**
 * Project validation.
 *
 * Every bound mirrors a CHECK constraint in 0007_projects.sql -- title 3..120,
 * tagline <= 160, description <= 10000, team target 1..50. The database is what
 * makes them true; this is what makes the refusal legible.
 *
 * `slug`, `owner_id`, `university_id` and the four counters are absent because they
 * are not the client's to send. The insert trigger overwrites them and the column
 * GRANT excludes them from updates, so sending them would be inert at best.
 */
export const projectCreateSchema = z.object({
  title: requiredText(3, 120, 'The title'),
  tagline: optionalText(160, 'The tagline'),
  description: optionalText(10000, 'The description'),
  category: z.enum(CATEGORY_VALUES as [string, ...string[]]),
  status: z.enum(PROJECT_STATUS_VALUES as [string, ...string[]]),
  visibility: z.enum(VISIBILITY_VALUES as [string, ...string[]]),
  repoUrl: optionalUrl(500, 'The repository link'),
  demoUrl: optionalUrl(500, 'The demo link'),
  isSeekingMembers: z
    .string()
    .optional()
    .transform((value) => value === 'on' || value === 'true'),
  lookingFor: optionalText(1000, 'What you are looking for'),
  teamSizeTarget: optionalInt(1, 50, 'A team target between 1 and 50'),
  startedAt: optionalDate('The start date'),
})

/**
 * Editing adds `completedAt`, which creation cannot set.
 *
 * Two constraints make that the honest shape: `projects_dates_coherent` requires a
 * completion date not before the start, and `projects_completed_status_coherent`
 * allows one only when the status is completed or abandoned. A brand-new project is
 * neither, so offering the field at creation would only produce a rejected form.
 */
export const projectEditSchema = projectCreateSchema.extend({
  completedAt: optionalDate('The completion date'),
})

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>
export type ProjectEditInput = z.infer<typeof projectEditSchema>
