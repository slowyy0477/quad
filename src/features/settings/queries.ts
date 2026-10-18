import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import { readStore } from '@/lib/local/db'
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
  if (isLocalMode()) {
    const user = await getUser()
    if (!user) {
      return { profile: null, error: 'Your settings could not be read. Reload the page to try again.' }
    }

    const db = await readStore()
    const me = db.profiles.find((profile) => profile.user_id === user.id)
    if (!me) {
      return { profile: null, error: 'Your settings could not be read. Reload the page to try again.' }
    }

    // The two messaging fields are optional on the local row because they were added
    // to the store after the first accounts existed. The defaults are the ones the
    // database's own column defaults use, so a profile that predates the columns reads
    // exactly like a freshly created one.
    return {
      profile: {
        visibility: me.visibility,
        allow_messages_from: me.allow_messages_from ?? 'everyone',
        allow_connection_requests: me.allow_connection_requests ?? true,
        searchable: me.searchable,
      },
      error: null,
    }
  }

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
