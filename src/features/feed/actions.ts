'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isSupabaseConfigured } from '@/lib/env'
import { id, mutate, now, readStore, type LocalProfile } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { createClient, getUser } from '@/lib/supabase/server'
import { localCanViewPost } from '@/features/feed/queries'
import type {
  CommentFormState,
  InteractionResult,
  PostFormState,
} from '@/features/feed/form-state'

/**
 * Feed write actions.
 *
 * Note what is absent: no `author_id` in the post or comment insert, and no
 * `profile_id` read from the form anywhere. For posts and comments the column
 * defaults to `auth.uid()` and a trigger overwrites whatever was sent, so the
 * author is established by the session rather than by a field the client controls.
 * For likes and saves there is no such trigger, so `profile_id` is taken from the
 * session *here* — never from the request — and the insert policy
 * (`profile_id = auth.uid()`) refuses anything else even if this file were wrong.
 *
 * The counts are never sent. `like_count`, `comment_count` and `save_count` are
 * trigger-maintained columns with no client UPDATE grant, and `post_likes`,
 * `post_saves` and `comments` are the rows those triggers read. Writing the row is
 * the only way to move the number, which is what makes the number honest.
 *
 * Every Postgres error is turned into a sentence before it leaves this file. A raw
 * PostgREST message names tables, columns and constraints, which is a free map of
 * the schema for anyone probing it.
 */

const UNAVAILABLE_POST: PostFormState = {
  status: 'error',
  message: 'Posting is unavailable: this deployment has no database.',
}

const UNAVAILABLE_COMMENT: CommentFormState = {
  status: 'error',
  message: 'Commenting is unavailable: this deployment has no database.',
}

/**
 * A row id, in whichever mode this process runs.
 *
 * Postgres ids are uuids and an id from a form is untrusted input, so the Supabase
 * path has to keep refusing anything that is not one. Local ids are minted by `id()`
 * in `@/lib/local/db` as `<prefix>_<base36>`, which the uuid rule rejects outright:
 * left as it was, every comment, like, save and attachment in local mode would fail
 * with "that post could not be identified" before it reached the store. So the
 * predicate is mode-aware rather than loosened for both modes at once.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_ID_SHAPE = /^[a-z0-9]+_[a-z0-9]+$/i

function isRowId(value: string): boolean {
  if (UUID_SHAPE.test(value)) return true
  return isLocalMode() && LOCAL_ID_SHAPE.test(value)
}

const requiredId = (message: string) => z.string().refine(isRowId, { message })

/** An empty form field arrives as `''`; a chosen id arrives as one of the above. */
const optionalId = (message: string) =>
  requiredId(message).optional().or(z.literal('').transform(() => undefined))

const postSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write something first')
    .max(5000, 'Posts are at most 5000 characters'),
  visibility: z.enum(['public', 'university', 'connections', 'private']),
  projectId: optionalId('That attachment could not be identified'),
  goalId: optionalId('That attachment could not be identified'),
})

const commentSchema = z.object({
  postId: requiredId('That post could not be identified'),
  parentId: optionalId('That attachment could not be identified'),
  body: z
    .string()
    .trim()
    .min(1, 'Write something first')
    .max(2000, 'Comments are at most 2000 characters'),
})

const interactionSchema = z.object({
  postId: requiredId('That post could not be identified'),
  active: z.boolean(),
})

/**
 * A PostgREST write error, as a sentence.
 *
 * 42501 is "insufficient privilege": it is what a policy or a column-level GRANT
 * refuses with, and both a hidden post and a missing grant arrive as this code, so
 * the message says "not allowed" rather than guessing which. The trigger hints are
 * matched on `hint` and not on message text, which is not a stable interface.
 */
function describePostWrite(
  error: { code?: string; hint?: string | null },
): Pick<PostFormState, 'message' | 'fieldErrors'> {
  if (error.hint === 'not_project_member') {
    return {
      message: 'You can only attach a project you are a member of.',
      fieldErrors: { projectId: 'You are not a member of that project.' },
    }
  }
  if (error.hint === 'goal_not_owned') {
    return {
      message: 'You can only attach your own goals.',
      fieldErrors: { goalId: 'That goal belongs to someone else.' },
    }
  }
  if (error.code === '42501') {
    return {
      message:
        'You are not allowed to post right now. If your account is new, finish onboarding first.',
    }
  }
  return { message: 'Your post could not be saved. Please try again.' }
}

export async function createPostAction(
  _previous: PostFormState,
  formData: FormData,
): Promise<PostFormState> {
  // Local mode has no Supabase and does not need one: the `isSupabaseConfigured`
  // refusal is about a missing deployment, not about a missing database.
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE_POST

  const raw = {
    body: String(formData.get('body') ?? ''),
    visibility: String(formData.get('visibility') ?? 'university'),
    projectId: String(formData.get('projectId') ?? ''),
    goalId: String(formData.get('goalId') ?? ''),
  }
  const parsed = postSchema.safeParse(raw)

  if (!parsed.success) {
    const fieldErrors: PostFormState['fieldErrors'] = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as keyof NonNullable<PostFormState['fieldErrors']>
      fieldErrors[key] ??= issue.message
    }
    return {
      status: 'error',
      fieldErrors,
      body: raw.body,
      projectId: raw.projectId || undefined,
      goalId: raw.goalId || undefined,
    }
  }

  // The type is derived from the attachment rather than asked for: a post attached
  // to a project is a project update, and offering the reader a dropdown that
  // disagreed with the attachment would let a "project update" be something else.
  const type = parsed.data.projectId
    ? 'project_update'
    : parsed.data.goalId
      ? 'learning_update'
      : 'text'

  if (isLocalMode()) {
    return createLocalPost({
      body: parsed.data.body,
      visibility: parsed.data.visibility,
      projectId: parsed.data.projectId,
      goalId: parsed.data.goalId,
    })
  }

  const supabase = await createClient()
  const { error } = await supabase.from('posts').insert({
    body: parsed.data.body,
    visibility: parsed.data.visibility,
    type,
    project_id: parsed.data.projectId ?? null,
    goal_id: parsed.data.goalId ?? null,
  })

  if (error) {
    console.error('[feed:createPost]', error.code, error.message)
    return {
      status: 'error',
      ...describePostWrite(error),
      body: parsed.data.body,
      projectId: parsed.data.projectId,
      goalId: parsed.data.goalId,
    }
  }

  revalidatePath('/feed')
  return { status: 'success' }
}

export async function createCommentAction(
  _previous: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE_COMMENT

  const raw = {
    postId: String(formData.get('postId') ?? ''),
    parentId: String(formData.get('parentId') ?? ''),
    body: String(formData.get('body') ?? ''),
  }
  const parsed = commentSchema.safeParse(raw)

  if (!parsed.success) {
    const fieldErrors: CommentFormState['fieldErrors'] = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as 'body'
      fieldErrors[key] ??= issue.message
    }
    return { status: 'error', fieldErrors, body: raw.body }
  }

  // No author_id: `comments_before_write` forces it to auth.uid() on insert.
  if (isLocalMode()) {
    return createLocalComment({
      postId: parsed.data.postId,
      parentId: parsed.data.parentId,
      body: parsed.data.body,
    })
  }

  const supabase = await createClient()
  const { error } = await supabase.from('comments').insert({
    post_id: parsed.data.postId,
    parent_id: parsed.data.parentId ?? null,
    body: parsed.data.body,
  })

  if (error) {
    console.error('[feed:createComment]', error.code, error.message)
    if (error.hint === 'max_depth') {
      return {
        status: 'error',
        message: 'Replies cannot be nested more than one level deep.',
        body: parsed.data.body,
      }
    }
    if (error.code === '23503') {
      return {
        status: 'error',
        message: 'The comment you replied to no longer exists.',
        body: parsed.data.body,
      }
    }
    if (error.code === '23514') {
      return {
        status: 'error',
        message: 'That comment is not allowed.',
        body: parsed.data.body,
      }
    }
    return {
      status: 'error',
      message:
        error.code === '42501'
          ? 'You are not allowed to comment on that post.'
          : 'Your comment could not be saved. Please try again.',
      body: parsed.data.body,
    }
  }

  revalidatePath(`/post/${parsed.data.postId}`)
  revalidatePath('/feed')
  return { status: 'success' }
}

/**
 * Like or unlike a post, to the state the caller asked for.
 *
 * Deliberately idempotent in both directions. A double tap sends two inserts, the
 * second collides with the primary key `(post_id, profile_id)` and returns 23505 —
 * which is not a failure, it is the database confirming the row already exists. So
 * 23505 is treated as success and the returned `active` is `true`. A delete of a
 * row that is not there is likewise a no-op: the requested state is already true.
 *
 * The interface is allowed to show this change before it is confirmed (UX §5 rule
 * 1 permits optimism for exactly like, save and RSVP) and reconciles against
 * `active`, so a failure reverts visibly rather than leaving a lie on screen.
 */
export async function setPostLikeAction(input: {
  postId: string
  active: boolean
}): Promise<InteractionResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: 'Liking is unavailable: this deployment has no database.' }
  }

  const parsed = interactionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'That post could not be identified.' }

  if (isLocalMode()) return setLocalLike(parsed.data.postId, parsed.data.active)

  const user = await getUser()
  // A signed-out visitor has no row to write. The action says so instead of
  // redirecting, because the post detail route renders for a signed-out reader.
  if (!user) return { ok: false, message: 'Sign in to like posts.' }

  const supabase = await createClient()

  if (parsed.data.active) {
    const { error } = await supabase
      .from('post_likes')
      // profile_id comes from the session, never from the request.
      .insert({ post_id: parsed.data.postId, profile_id: user.id })

    if (error && error.code !== '23505') {
      console.error('[feed:like]', error.code, error.message)
      return {
        ok: false,
        message:
          error.code === '42501'
            ? 'You are not allowed to like that post.'
            : 'That like could not be saved. Please try again.',
      }
    }
  } else {
    const { error } = await supabase
      .from('post_likes')
      .delete()
      .eq('post_id', parsed.data.postId)
      .eq('profile_id', user.id)

    if (error) {
      console.error('[feed:unlike]', error.code, error.message)
      return { ok: false, message: 'That like could not be removed. Please try again.' }
    }
  }

  revalidatePath('/feed')
  revalidatePath(`/post/${parsed.data.postId}`)
  return { ok: true, active: parsed.data.active }
}

/**
 * Save or unsave a post.
 *
 * A save is private: `post_saves` has no SELECT policy for anyone but the saver, so
 * there is no public count to move and no way to see what someone else bookmarked.
 * `posts.save_count` exists and is trigger-maintained, but it is not shown anywhere
 * in the feed, because showing it would tell the reader how many people bookmarked
 * something they cannot see.
 */
export async function setPostSaveAction(input: {
  postId: string
  active: boolean
}): Promise<InteractionResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: 'Saving is unavailable: this deployment has no database.' }
  }

  const parsed = interactionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'That post could not be identified.' }

  if (isLocalMode()) return setLocalSave(parsed.data.postId, parsed.data.active)

  const user = await getUser()
  if (!user) return { ok: false, message: 'Sign in to save posts.' }

  const supabase = await createClient()

  if (parsed.data.active) {
    const { error } = await supabase
      .from('post_saves')
      .insert({ post_id: parsed.data.postId, profile_id: user.id })

    if (error && error.code !== '23505') {
      console.error('[feed:save]', error.code, error.message)
      return {
        ok: false,
        message:
          error.code === '42501'
            ? 'You are not allowed to save that post.'
            : 'That post could not be saved. Please try again.',
      }
    }
  } else {
    const { error } = await supabase
      .from('post_saves')
      .delete()
      .eq('post_id', parsed.data.postId)
      .eq('profile_id', user.id)

    if (error) {
      console.error('[feed:unsave]', error.code, error.message)
      return { ok: false, message: 'That post could not be removed from your saves.' }
    }
  }

  revalidatePath('/feed')
  return { ok: true, active: parsed.data.active }
}

// =============================================================================
// Local mode
// =============================================================================
//
// In local mode this file *is* the authorisation layer. There is no RLS, no
// `posts_before_write`, no `comments_before_write` and no counter triggers
// underneath, so each rule those enforce is written out here — and each refusal
// uses the same sentence the Supabase path produces for the same case, so a form
// behaves identically whichever store is behind it.
//
// Writes go through `mutate`, which queues the file write. Nothing sets a counter:
// `like_count` and `comment_count` are derived when a row is read, so there is no
// cached number to keep in step.

/**
 * A post the reader is allowed to act on, plus the reader's profile.
 *
 * The same predicate the read paths use, for the same reason a policy is applied to
 * both SELECT and INSERT in Postgres: a like on a post you cannot see is not a
 * success, it is a row nobody can explain.
 */
async function localPostFor(
  postId: string,
  messages: { signedOut: string; refused: string },
): Promise<{ me: LocalProfile } | { failure: InteractionResult }> {
  const user = await getUser()
  if (!user) return { failure: { ok: false, message: messages.signedOut } }

  const db = await readStore()
  const me = db.profiles.find((profile) => profile.user_id === user.id)
  const post = db.posts.find((candidate) => candidate.id === postId)
  const author = post ? db.profiles.find((profile) => profile.id === post.author_id) : undefined

  if (!me) return { failure: { ok: false, message: messages.signedOut } }
  if (!post || !localCanViewPost(post, me, author)) {
    return { failure: { ok: false, message: messages.refused } }
  }

  return { me }
}

/**
 * `app.clamp_visibility`: the less visible of what was asked for and what the
 * author's own profile allows. Every local profile is `public`, so this is a no-op
 * today — it is here because it is the trigger that makes the ceiling hold no matter
 * which code path writes the row, and a private profile must not publish wider than
 * itself.
 */
const VISIBILITY_ORDER = ['private', 'connections', 'university', 'public'] as const

type Visibility = (typeof VISIBILITY_ORDER)[number]

function clampVisibility(requested: Visibility, ceiling: Visibility): Visibility {
  const wanted = VISIBILITY_ORDER.indexOf(requested)
  const allowed = VISIBILITY_ORDER.indexOf(ceiling)
  if (wanted === -1 || allowed === -1) return 'private'
  return VISIBILITY_ORDER[Math.min(wanted, allowed)]
}

/**
 * `createPostAction` in local mode.
 *
 * The author comes from the session — never from the form — exactly as the column
 * default and the insert trigger arrange it in Postgres, and the two attachment
 * rules are checked here because there is no `posts_before_write` to raise
 * `not_project_member` or `goal_not_owned`.
 *
 * The stored row has no `type`: the local `posts` table does not carry one, so it is
 * derived from the attachment on read (see `localFeedPost`), which is the same rule
 * used here to decide what kind of update this is.
 */
async function createLocalPost(input: {
  body: string
  visibility: 'public' | 'university' | 'connections' | 'private'
  projectId?: string
  goalId?: string
}): Promise<PostFormState> {
  // Kept so a rejected post is not thrown away, the same way the Supabase path
  // returns the body and the attachment it was given.
  const kept = { body: input.body, projectId: input.projectId, goalId: input.goalId }

  const user = await getUser()
  if (!user) return { status: 'error', message: 'Sign in to post.', ...kept }

  const db = await readStore()
  const me = db.profiles.find((profile) => profile.user_id === user.id)
  if (!me) {
    return {
      status: 'error',
      message: 'This account has no profile yet. Finish onboarding first.',
      ...kept,
    }
  }

  if (input.projectId) {
    const project = db.projects.find(
      (candidate) => candidate.id === input.projectId && candidate.deleted_at === null,
    )
    const member = project
      ? db.project_members.some(
          (row) => row.project_id === project.id && row.profile_id === me.id,
        )
      : false

    if (!project || !member) {
      return {
        status: 'error',
        message: 'You can only attach a project you are a member of.',
        fieldErrors: { projectId: 'You are not a member of that project.' },
        ...kept,
      }
    }
  }

  if (input.goalId) {
    const goal = db.goals.find((candidate) => candidate.id === input.goalId)
    if (!goal || goal.profile_id !== me.id) {
      return {
        status: 'error',
        message: 'You can only attach your own goals.',
        fieldErrors: { goalId: 'That goal belongs to someone else.' },
        ...kept,
      }
    }
  }

  await mutate((store) => {
    store.posts.push({
      id: id('pst'),
      author_id: me.id,
      body: input.body,
      visibility: clampVisibility(input.visibility, me.visibility),
      project_id: input.projectId ?? null,
      goal_id: input.goalId ?? null,
      moderation_status: 'active',
      // Both counters are caches in Postgres. Nothing reads them as truth in local
      // mode, and nothing writes them after this line.
      like_count: 0,
      comment_count: 0,
      created_at: now(),
      deleted_at: null,
    })
  })

  revalidatePath('/feed')
  return { status: 'success' }
}

/**
 * `createCommentAction` in local mode.
 *
 * `comments_before_write` does three things in Postgres and all three are here: the
 * author is the session's profile, the parent must be a top-level comment on the
 * same post (`max_depth`), and the comment must be on a post the reader can see.
 */
async function createLocalComment(input: {
  postId: string
  parentId?: string
  body: string
}): Promise<CommentFormState> {
  const user = await getUser()
  if (!user) return { status: 'error', message: 'Sign in to comment.', body: input.body }

  const db = await readStore()
  const me = db.profiles.find((profile) => profile.user_id === user.id)
  if (!me) {
    return {
      status: 'error',
      message: 'This account has no profile yet. Finish onboarding first.',
      body: input.body,
    }
  }

  const post = db.posts.find((candidate) => candidate.id === input.postId)
  const author = post ? db.profiles.find((profile) => profile.id === post.author_id) : undefined
  if (!post || !localCanViewPost(post, me, author)) {
    return {
      status: 'error',
      message: 'You are not allowed to comment on that post.',
      body: input.body,
    }
  }

  if (input.parentId) {
    const parent = db.comments.find((candidate) => candidate.id === input.parentId)
    if (!parent || parent.deleted_at !== null || parent.post_id !== input.postId) {
      return {
        status: 'error',
        message: 'The comment you replied to no longer exists.',
        body: input.body,
      }
    }
    if (parent.parent_id !== null) {
      return {
        status: 'error',
        message: 'Replies cannot be nested more than one level deep.',
        body: input.body,
      }
    }
  }

  await mutate((store) => {
    store.comments.push({
      id: id('cmt'),
      post_id: input.postId,
      author_id: me.id,
      parent_id: input.parentId ?? null,
      body: input.body,
      created_at: now(),
      deleted_at: null,
    })
  })

  revalidatePath(`/post/${input.postId}`)
  revalidatePath('/feed')
  return { status: 'success' }
}

/**
 * `setPostLikeAction` in local mode.
 *
 * Idempotent in both directions, for the reason the Supabase version explains: a
 * double tap asks for a state, not for a second row. One row per profile per post —
 * which in Postgres is the primary key `(post_id, profile_id)` and here is a check
 * before the push — and unliking removes the row rather than setting a flag, so the
 * count that is derived on read follows.
 */
async function setLocalLike(postId: string, active: boolean): Promise<InteractionResult> {
  const guard = await localPostFor(postId, {
    signedOut: 'Sign in to like posts.',
    refused: 'You are not allowed to like that post.',
  })
  if ('failure' in guard) return guard.failure

  const me = guard.me
  await mutate((store) => {
    const mine = (row: { post_id: string; profile_id: string }) =>
      row.post_id === postId && row.profile_id === me.id

    if (active) {
      if (!store.post_likes.some(mine)) {
        store.post_likes.push({
          id: id('lke'),
          post_id: postId,
          profile_id: me.id,
          created_at: now(),
        })
      }
    } else {
      store.post_likes = store.post_likes.filter((row) => !mine(row))
    }
  })

  revalidatePath('/feed')
  revalidatePath(`/post/${postId}`)
  return { ok: true, active }
}

/**
 * `setPostSaveAction` in local mode.
 *
 * A save is private in Postgres by policy; here it is private by never being
 * counted in public. `save_count` is derived from these rows for the post's own
 * shape, and nothing in the interface renders it.
 */
async function setLocalSave(postId: string, active: boolean): Promise<InteractionResult> {
  const guard = await localPostFor(postId, {
    signedOut: 'Sign in to save posts.',
    refused: 'You are not allowed to save that post.',
  })
  if ('failure' in guard) return guard.failure

  const me = guard.me
  await mutate((store) => {
    const mine = (row: { post_id: string; profile_id: string }) =>
      row.post_id === postId && row.profile_id === me.id

    if (active) {
      if (!store.post_saves.some(mine)) {
        store.post_saves.push({
          id: id('sav'),
          post_id: postId,
          profile_id: me.id,
          created_at: now(),
        })
      }
    } else {
      store.post_saves = store.post_saves.filter((row) => !mine(row))
    }
  })

  revalidatePath('/feed')
  return { ok: true, active }
}
