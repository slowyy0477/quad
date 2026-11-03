import 'server-only'

import { isLocalMode } from '@/lib/mode'
import { isSupabaseConfigured } from '@/lib/env'
import { getLocalUser } from '@/lib/local/session'
import { readLocalProjectCover } from '@/lib/local/media'
import { createClient } from '@/lib/supabase/server'
import { imageFromDatabase } from './supabase'
import type { UploadedImage } from './contracts'
import { uploadsUnavailable } from './errors'

/** Add this to the project detail/card query; no local schema additions needed. */
export async function getReadableProjectCover(projectId: string): Promise<UploadedImage | null> {
  if (isLocalMode()) {
    const user = await getLocalUser() // No ensureSeeded or writes from a media read.
    return readLocalProjectCover(projectId, user?.id ?? null)
  }
  if (!isSupabaseConfigured()) return null
  const client = await createClient()
  const result = await client.from('private_images').select('id,kind,state,byte_count,width,height')
    .eq('project_id', projectId).eq('kind', 'project-cover').eq('state', 'ready').maybeSingle()
  if (result.error) throw uploadsUnavailable()
  return result.data ? imageFromDatabase(result.data) : null
}
