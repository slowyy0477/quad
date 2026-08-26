'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isSupabaseConfigured } from '@/lib/env'
import type { PostFormState } from '@/features/feed/form-state'

/**
 * Feed write actions.
 *
 * Note what is absent: no `author_id` in the insert. The column defaults to
 * `auth.uid()` and the insert policy requires it to equal `auth.uid()`, so the
 * author is established by the session rather than by a field the client sends.
 * Accepting an author id from the form would let anyone post as anyone.
 */

const postSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write something first')
    .max(5000, 'Posts are at most 5000 characters'),
  visibility: z.enum(['public', 'university', 'connections', 'private']),
})

export async function createPostAction(
  _previous: PostFormState,
  formData: FormData,
): Promise<PostFormState> {
  if (!isSupabaseConfigured()) {
    return { status: 'error', message: 'Posting is unavailable: this deployment has no database.' }
  }

  const raw = {
    body: String(formData.get('body') ?? ''),
    visibility: String(formData.get('visibility') ?? 'university'),
  }
  const parsed = postSchema.safeParse(raw)

  if (!parsed.success) {
    const fieldErrors: PostFormState['fieldErrors'] = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as 'body' | 'visibility'
      fieldErrors[key] ??= issue.message
    }
    return { status: 'error', fieldErrors, body: raw.body }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('posts').insert({
    body: parsed.data.body,
    visibility: parsed.data.visibility,
    type: 'text',
  })

  if (error) {
    console.error('[feed:createPost]', error.code, error.message)
    // 42501 is "insufficient privilege" — an RLS policy said no. Everything else
    // is a bug on our side, and neither message should quote the database.
    return {
      status: 'error',
      message:
        error.code === '42501'
          ? 'You are not allowed to post right now. If your account is new, finish onboarding first.'
          : 'Your post could not be saved. Please try again.',
      body: parsed.data.body,
    }
  }

  revalidatePath('/feed')
  return { status: 'success' }
}
