import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/db/database.types'

/**
 * Settings reads.
 *
 * Typed from the generated schema rather than from a hand-written interface: this query
 * was written against `profiles` and the point of `database.types.ts` is that a renamed or
 * dropped column fails here instead of at runtime in someone's browser.
 */
export type PrivacySettings = {
  visibility: Database['public']['Tables']['profiles']['Row']['visibility']
  allow_messages_from: Database['public']['Tables']['profiles']['Row']['allow_messages_from']
  allow_connection_requests: boolean
  searchable: boolean
}

export async function getOwnSettings(): Promise<{
  profile: PrivacySettings | null
  error: string | null
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('profiles')
    .select('visibility, allow_messages_from, allow_connection_requests, searchable')
    .maybeSingle<PrivacySettings>()

  if (error) {
    console.error('[settings:getOwnSettings]', error.code, error.message)
    return { profile: null, error: 'Your settings could not be read. Reload the page to try again.' }
  }

  return { profile: data ?? null, error: null }
}
