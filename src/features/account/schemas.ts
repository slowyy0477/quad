import { z } from 'zod'
import { DELETE_ACCOUNT_CONFIRMATION, EXPORT_DEFAULT_ROWS, EXPORT_MAX_ROWS, EXPORT_SECTION_NAMES } from './policy'
import type { ExportSection } from './policy'

// Sign-in compatibility: do not impose the NEW-password policy on reauthentication.
export const currentPasswordSchema = z.string().max(1024).default('')
export const accountTotpSchema = z.string().refine(value => value === '' || /^\d{6}$/.test(value)).default('')
export const exportOptionsSchema = z.object({
  section: z.enum(EXPORT_SECTION_NAMES as [ExportSection, ...ExportSection[]]).optional(),
  after: z.string().max(256).regex(/^[A-Za-z0-9_:-]+$/).optional(),
  limit: z.number().int().min(1).max(EXPORT_MAX_ROWS).default(EXPORT_DEFAULT_ROWS),
}).strict().refine((value) => !value.after || Boolean(value.section), {
  message: 'Continuation requires a section.', path: ['after'],
})

export const exportRequestSchema = z.object({
  password: currentPasswordSchema,
  totpCode: accountTotpSchema,
  section: z.enum(EXPORT_SECTION_NAMES as [ExportSection, ...ExportSection[]]).optional(),
  after: z.string().max(256).regex(/^[A-Za-z0-9_:-]+$/).optional(),
  limit: z.number().int().min(1).max(EXPORT_MAX_ROWS).default(EXPORT_DEFAULT_ROWS),
}).strict().refine((value) => !value.after || Boolean(value.section), {
  message: 'Continuation requires a section.', path: ['after'],
})

export const deletionRequestSchema = z.object({
  password: currentPasswordSchema,
  totpCode: accountTotpSchema,
  confirmation: z.literal(DELETE_ACCOUNT_CONFIRMATION),
  acknowledge: z.literal(true),
  idempotencyKey: z.uuid(),
}).strict()

export const receiptRequestSchema = z.object({ receipt: z.uuid() }).strict()
