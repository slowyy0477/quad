import type { ExportSection } from './policy'

export type LifecycleErrorCode =
  | 'signed_out'
  | 'identity_mismatch'
  | 'invalid_password'
  | 'throttled'
  | 'invalid_request'
  | 'confirmation_required'
  | 'ownership_transfer_required'
  | 'owner_role_inconsistent'
  | 'last_administrator'
  | 'shared_media_ownership'
  | 'provider_assurance_required'
  | 'account_unavailable'
  | 'export_too_large'
  | 'unavailable'
  | 'not_found'

export type LifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LifecycleErrorCode; retryAfterSeconds?: number }

export type DeletionState = 'queued' | 'processing' | 'retry' | 'blocked' | 'failed' | 'completed'
export type DeletionPhase = 'content' | 'media' | 'auth' | 'complete'
export type DeletionReceipt = {
  id: string
  state: DeletionState
  phase: DeletionPhase
}

export type OwnershipBlockers = {
  projects: { id: string; slug: string; title: string; deleted: boolean }[]
  moreProjects: boolean
  inconsistentOwnerRole: boolean
  lastAdministrator: boolean
  sharedMedia: boolean
  ownedStorageBucket: boolean
}

export type AccountSummary = {
  mode: 'local' | 'supabase'
  blockers: OwnershipBlockers
  /** Configuration, not proof of worker deployment or successful invocation. */
  hostedCleanupEnabled: boolean
}

export type ExportOptions = {
  section?: ExportSection
  after?: string
  limit?: number
}

export type ExportRecord = Record<string, string | number | boolean | null>
export type ExportPage = { records: ExportRecord[]; next_cursor: string | null }
export type AccountExport = {
  schema_version: 1
  policy_version: string
  mode: 'local' | 'supabase'
  generated_at: string
  subject: { user_id: string; profile_id: string; email: string | null }
  sections: Partial<Record<ExportSection, ExportPage>>
  complete_for_selected_sections: boolean
  excluded: readonly string[]
  continuation: { method: 'POST'; path: '/api/account/export'; reauthenticate_each_page: true }
}

/** Error copy is deliberately independent of provider errors/private content. */
export const LIFECYCLE_ERROR_MESSAGES: Record<LifecycleErrorCode, string> = {
  signed_out: 'Your session is no longer available. Sign in again before trying this action.',
  identity_mismatch: 'Your signed-in account changed. Reload this page and try again.',
  invalid_password: 'That current password could not be verified.',
  throttled: 'Too many verification attempts. Wait before trying again.',
  invalid_request: 'These account-action details are not valid.',
  confirmation_required: 'Type DELETE MY ACCOUNT exactly and acknowledge the deletion policy.',
  ownership_transfer_required: 'Transfer your shared projects before deleting your account. Soft deletion alone does not resolve ownership.',
  owner_role_inconsistent: 'A project owner role needs to be resolved before this account can be deleted.',
  last_administrator: 'Assign another active administrator before deleting the last administrator account.',
  shared_media_ownership: 'Shared media or a Storage bucket still needs an ownership review. Nothing has been queued.',
  provider_assurance_required: 'Use your current password, or complete fresh strong provider verification. Email/recovery links alone do not authorize this action.',
  account_unavailable: 'This account is unavailable or already awaiting deletion.',
  export_too_large: 'This export page is too large. Select one section and fewer rows; your stored data has not changed.',
  unavailable: 'This action could not be completed just now. Try again, or check an existing deletion receipt before resubmitting.',
  not_found: 'That deletion receipt was not found or has expired.',
}
