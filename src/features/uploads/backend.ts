import 'server-only'

import { isLocalMode, assertNotDeployedInLocalMode } from '@/lib/mode'
import { isSupabaseConfigured } from '@/lib/env'
import { createLocalImageBackend } from '@/lib/local/media'
import { createSupabaseImageBackend } from './supabase'
import { uploadsUnavailable } from './errors'
import type { ImageBackend } from './types'

export async function createImageBackend(request: Request, write = false): Promise<ImageBackend> {
  try { assertNotDeployedInLocalMode() } catch { throw uploadsUnavailable() }
  if (isLocalMode()) return createLocalImageBackend(request)
  if (!isSupabaseConfigured()) throw uploadsUnavailable()
  return createSupabaseImageBackend(write)
}
