import 'server-only'

import { createClient } from '@/lib/supabase/server'

/**
 * Feed queries.
 *
 * There is no `visibility` filter in any of these selects, and that is not an
 * oversight. Row-level security decides what each row's reader is allowed to see,
 * inside Postgres, on every query. Repeating the rule here in TypeScript would
 * add a second copy that can drift out of step with the first — and the copy that
 * matters is the one an attacker cannot skip by talking to PostgREST directly.
 *
 * What is filtered here is `deleted_at` and `moderation_status`, because those are
 * not access-control questions. A removed post is invisible to everyone including
 * its author, and the policies leave it readable so moderators can review it.
 */

export type FeedPost = {
  id: string
  type: string
  title: string | null
  body: string | null
  link_url: string | null
  like_count: number
  comment_count: number
  created_at: string
  is_edited: boolean
  author: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

const POST_SELECT = `
  id, type, title, body, link_url, like_count, comment_count, created_at, is_edited,
  author:profiles!posts_author_id_fkey ( id, username, display_name, avatar_url, headline )
`

/**
 * The chronological feed of everything this reader may see.
 *
 * Keyset pagination rather than `offset`: a feed that people write to while you
 * are reading it shifts under an offset, so page two silently skips or repeats
 * rows. A cursor on `created_at` cannot.
 */
export async function getFeedPosts({
  limit = 20,
  before,
}: { limit?: number; before?: string } = {}): Promise<
  { posts: FeedPost[]; error: null } | { posts: null; error: string }
> {
  const supabase = await createClient()

  let query = supabase
    .from('posts')
    .select(POST_SELECT)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query.returns<FeedPost[]>()

  if (error) {
    // Logged in full, reported as a sentence. A PostgREST error message can name
    // tables, columns and constraints, which is a free map of the schema.
    console.error('[feed:getFeedPosts]', error.code, error.message)
    return { posts: null, error: 'The feed could not be loaded. Please try again.' }
  }

  return { posts: data ?? [], error: null }
}
