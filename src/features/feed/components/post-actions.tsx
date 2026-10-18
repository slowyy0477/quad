'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Bookmark, Heart, Link2, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { setPostLikeAction, setPostSaveAction } from '@/features/feed/actions'

/**
 * The controls on a post: like, comment, save, copy link.
 *
 * **Optimism, and its limits.** UX §5 rule 1 permits a control to show its result
 * before the server confirms it for exactly like, save and RSVP. This does that
 * for exactly those two — and it reconciles. The state is set from the server's
 * answer after the write, not from the assumption that the write succeeded, so a
 * failure puts the control back where it was *and* says so. An optimistic update
 * that never reverts is a lie with a nice animation.
 *
 * **No invented number.** The count rendered is the stored `like_count` plus the
 * difference this reader has made — at most one. It is never a guess, and once the
 * server action revalidates `/feed` the stored value arrives and the two agree.
 *
 * Both writes are idempotent server-side (a duplicate like is a primary-key
 * collision, which the action treats as success), so a double tap cannot produce a
 * count of two.
 */
export function PostActions({
  postId,
  likeCount,
  commentCount,
  initiallyLiked,
  initiallySaved,
  signedIn,
  commentHref,
  permalink,
}: {
  postId: string
  likeCount: number
  commentCount: number
  initiallyLiked: boolean
  initiallySaved: boolean
  signedIn: boolean
  commentHref: string
  /** The post's canonical path. Omitted on the feed, where a copy link is noise. */
  permalink?: string
}) {
  const [liked, setLiked] = useState(initiallyLiked)
  const [saved, setSaved] = useState(initiallySaved)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [lastProps, setLastProps] = useState({ liked: initiallyLiked, saved: initiallySaved })

  // A fresh server render — after `revalidatePath`, or because another tab wrote —
  // changes these props. Adjusting state during render (not in an effect) is React's
  // documented pattern for that, and it is what keeps the count honest in the
  // cross-tab case: without it, a like cast elsewhere would arrive as a higher
  // `likeCount` while this component still believed the reader had not liked it,
  // and the two would subtract to the wrong number.
  if (lastProps.liked !== initiallyLiked || lastProps.saved !== initiallySaved) {
    setLastProps({ liked: initiallyLiked, saved: initiallySaved })
    if (lastProps.liked !== initiallyLiked) setLiked(initiallyLiked)
    if (lastProps.saved !== initiallySaved) setSaved(initiallySaved)
  }

  const displayedLikes = likeCount + (Number(liked) - Number(initiallyLiked))

  function toggleLike() {
    const next = !liked
    const previous = liked
    setLiked(next)
    setError(null)
    startTransition(async () => {
      const result = await setPostLikeAction({ postId, active: next })
      if (result.ok) setLiked(result.active)
      else {
        setLiked(previous)
        setError(result.message)
      }
    })
  }

  function toggleSave() {
    const next = !saved
    const previous = saved
    setSaved(next)
    setError(null)
    startTransition(async () => {
      const result = await setPostSaveAction({ postId, active: next })
      if (result.ok) setSaved(result.active)
      else {
        setSaved(previous)
        setError(result.message)
      }
    })
  }

  async function copyLink() {
    if (!permalink) return
    try {
      await navigator.clipboard.writeText(permalink)
      // A confirmation, never an error: sonner is for "it worked", and a failure
      // to copy is not worth interrupting anyone over.
      toast('Link copied')
    } catch {
      toast('Copy it from the address bar')
    }
  }

  if (!signedIn) {
    return (
      <div className="mt-3 border-t border-hairline pt-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/login?next=${encodeURIComponent(permalink ?? commentHref)}`} className="text-accent-700 underline underline-offset-2">
            Sign in
          </Link>{' '}
          to like, save and comment on this post.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={toggleLike}
          aria-pressed={liked}
          aria-label={liked ? 'Remove your like' : 'Like this post'}
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded px-2 text-xs',
            'hover:bg-paper-sunken',
            liked ? 'text-danger-600' : 'text-ink-faint',
          )}
        >
          <Heart className={cn('size-4', liked ? 'fill-current' : undefined)} aria-hidden="true" />
          <span className="tabular">{displayedLikes}</span>
        </button>

        <Link
          href={commentHref}
          className="inline-flex min-h-9 items-center gap-1.5 rounded px-2 text-xs text-ink-faint hover:bg-paper-sunken hover:text-ink"
        >
          <MessageSquare className="size-4" aria-hidden="true" />
          <span className="tabular">{commentCount}</span>
          <span className="sr-only">comments</span>
        </Link>

        <button
          type="button"
          onClick={toggleSave}
          aria-pressed={saved}
          aria-label={saved ? 'Remove from your saved posts' : 'Save this post to your private list'}
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded px-2 text-xs',
            'hover:bg-paper-sunken',
            saved ? 'text-accent-700' : 'text-ink-faint',
          )}
        >
          <Bookmark className={cn('size-4', saved ? 'fill-current' : undefined)} aria-hidden="true" />
          <span>Save</span>
        </button>

        {permalink ? (
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex min-h-9 items-center gap-1.5 rounded px-2 text-xs text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <Link2 className="size-4" aria-hidden="true" />
            <span>Copy link</span>
          </button>
        ) : null}

        {/* The controls stay enabled while a write is in flight — disabling them
            would drop a control out of the tab order mid-interaction — and this
            announces the wait instead. A double tap is safe anyway: the server
            treats a duplicate like as a primary-key collision and reports success. */}
        {pending ? (
          <span className="sr-only" role="status">
            Saving your change
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-1 text-xs font-medium text-danger-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}
