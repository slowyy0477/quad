import { z } from 'zod'

/**
 * Skill and interest validation.
 *
 * The enumerations are copies of the CHECK constraints in
 * 0006_skills_and_interests.sql, and they are copies on purpose: the database is
 * what makes each rule true, and these exist so a bad value produces a sentence
 * rather than a constraint name.
 */

export const skillLevelSchema = z.enum(['learning', 'familiar', 'proficient', 'advanced'])

export const skillCategorySchema = z.enum([
  'language',
  'framework',
  'tool',
  'platform',
  'database',
  'design',
  'data',
  'devops',
  'soft',
  'academic',
  'other',
])

export const interestCategorySchema = z.enum([
  'academic',
  'technology',
  'creative',
  'business',
  'social',
  'sport',
  'other',
])

const catalogueName = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter a ${label}`)
    .max(60, `Use at most 60 characters`)

export const attachSkillSchema = z.object({
  skillId: z.string().uuid('Choose a skill from the list'),
  level: skillLevelSchema,
  isLearning: z.boolean(),
})

export const proposeSkillSchema = z.object({
  name: catalogueName('skill'),
  category: skillCategorySchema,
})

export const updateProfileSkillSchema = z.object({
  skillId: z.string().uuid('That skill could not be identified'),
  level: skillLevelSchema,
  isLearning: z.boolean(),
})

export const skillIdSchema = z.object({
  skillId: z.string().uuid('That skill could not be identified'),
})

export const interestIdSchema = z.object({
  interestId: z.string().uuid('That interest could not be identified'),
})

export const proposeInterestSchema = z.object({
  name: catalogueName('topic'),
  category: interestCategorySchema,
})

export const SKILL_LEVEL_LABELS: Record<z.infer<typeof skillLevelSchema>, string> = {
  learning: 'Learning',
  familiar: 'Familiar',
  proficient: 'Proficient',
  advanced: 'Advanced',
}

export const SKILL_CATEGORY_LABELS: Record<z.infer<typeof skillCategorySchema>, string> = {
  language: 'Language',
  framework: 'Framework',
  tool: 'Tool',
  platform: 'Platform',
  database: 'Database',
  design: 'Design',
  data: 'Data',
  devops: 'Ops',
  soft: 'Working with people',
  academic: 'Academic',
  other: 'Other',
}

export const INTEREST_CATEGORY_LABELS: Record<z.infer<typeof interestCategorySchema>, string> = {
  academic: 'Academic',
  technology: 'Technology',
  creative: 'Creative',
  business: 'Business',
  social: 'Social',
  sport: 'Sport',
  other: 'Other',
}
