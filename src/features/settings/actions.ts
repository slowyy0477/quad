'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isSupabaseConfigured } from '@/lib/env'
import type { SettingsFormState } from '@/features/settings/form-state'

/**
 * Settings writes.
 *
 * Every field here maps to a column that already exists on `profiles` and that the
 * `profiles_update_own` policy plus a column-level GRANT already permit an owner to
 * write. Nothing new is invented: a setting with no column behind it would be a control
 * that appears to work and does not, which is exactly what PRODUCT.md rule 2 forbids.
 *
 * `update` is called with no `.eq()` on purpose. The policy restricts the row to the
 * caller, and adding a client-supplied id would create the illusion that the client
 * chose which row was written.
 */

const privacySchema = z.object({
  visibility: z.enum(['public', 'university', 'connections', 'private']),
  allow_messages_from: z.enum(['everyone', 'university', 'connections', 'nobody']),
  allow_connection_requests: z.coerce.boolean(),
  searchable: z.coerce.boolean(),
})

export async function updatePrivacyAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  if (!isSupabaseConfigured()) {
    return { status: 'error', message: 'Settings are unavailable: this deployment has no database.' }
  }

  const parsed = privacySchema.safeParse({
    visibility: formData.get('visibility'),
    allow_messages_from: formData.get('allow_messages_from'),
    // An unchecked checkbox is absent from FormData, which is not the same as "false".
    allow_connection_requests: formData.get('allow_connection_requests') !== null,
    searchable: formData.get('searchable') !== null,
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return { status: 'error', message: 'That combination is not valid.', fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('profiles').update(parsed.data)

  if (error) {
    console.error('[settings:updatePrivacy]', error.code, error.message)
    if (error.code === '42501') {
      return { status: 'error', message: 'You are not allowed to change these settings.' }
    }
    return { status: 'error', message: 'Your settings could not be saved. Please try again.' }
  }

  revalidatePath('/settings')
  revalidatePath('/me')
  return { status: 'saved', message: 'Privacy settings saved.' }
}
