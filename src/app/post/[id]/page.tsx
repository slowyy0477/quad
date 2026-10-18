import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { encodeCursor } from '@/lib/cursor'
import { isSupabaseConfigured, siteUrl } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { CommentComposer } from '@/features/feed/components/comment-composer'
import { CommentThread } from '@/features/feed/components/comment-thread'
import { PostCard } from '@/features/feed/components/post-card'
import { getCommentReplies, getPostComments, getPostDetail } from '@/features/feed/queries'

type Params = { id: string }
type SearchParams = Record<string, string | string[] | undefined>

/**
 * A post's permalink.
 *
 * This is what a shared link opens — a post spread by WhatsApp is the unit a
 * university network actually travels in — so it has to work for a signed-out
 * visitor. It does: `proxy.ts` gates `/feed`, not `/post`, and the post itself is
 * read through RLS, so an anonymous reader sees a public post and nothing else. The
 * actions are not hidden from that visitor; they are replaced by a sign-in prompt,
 * because hiding them leaves the reader wondering whether the feature exists.
 *
 * A post the reader may not see is a `notFound()`, the same answer `/u/[username]`
 * gives to a profile it cannot show. A private post's URL does not render part of
 * it and does not say "you are not allowed" — telling the two apart would confirm
 * the existence of a post to exactly the person who was refused access to it.
 *
 * The comment thread is paginated with the same opaque `(created_at, id)` cursor as
 * the feed, walking forwards from the oldest comment because that is the direction
 * a thread is read in.
 */
function excerpt(post: { title: string | null; body: string | null }): string {
  const body = post.body?.replace(/\s+/g, ' ').trim() ?? ''
  if (body) return body.length > 200 ? `${body.slice(0, 197)}…` : body
  return post.title ?? 'A post on Quad'
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Post' }

  const { id } = await params
  const post = await getPostDetail(id)
  // No distinction between "no such post" and "not allowed to see it", here either.
  if (!post) return { title: 'Post not found' }

  const author = post.author?.display_name ?? 'A Quad member'
  const title = post.title ?? `${author} on Quad`
  const description = excerpt(post)

  return {
    title,
    description,
    // OpenGraph from real fields only: the author's stored name, the post's own
    // title and body, and the row's created_at. There is deliberately no image —
    // there is no media pipeline yet, and an invented preview image would be a
    // claim about a file that does not exist.
    openGraph: {
      title,
      description,
      type: 'article',
      publishedTime: post.created_at,
      url: `${siteUrl()}/post/${post.id}`,
    },
    twitter: { card: 'summary', title, description },
  }
}

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Post</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            A post is a row in Postgres. Without Supabase credentials there is nothing to show, and
            this page will not render an invented one. <Link href="/setup">Configuration steps</Link>
            .
          </p>
        </Alert>
      </div>
    )
  }

  const { id } = await params
  const query = await searchParams
  const post = await getPostDetail(id)
  if (!post) notFound()

  const [user, comments] = await Promise.all([
    getUser(),
    getPostComments(id, { cursor: query.cursor }),
  ])

  const topLevel = comments.comments ?? []
  const replies = await getCommentReplies(topLevel.map((comment) => comment.id))
  const signedIn = Boolean(user)
  const permalink = `${siteUrl()}/post/${post.id}`
  const moreCommentsHref = comments.nextCursor
    ? `${cursorHref(`/post/${post.id}`, {}, encodeCursor(comments.nextCursor))}#comments`
    : null

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <p className="mb-4 text-xs text-ink-faint">
        <Link href="/feed" className="text-accent-700 underline underline-offset-2">
          Back to the feed
        </Link>
      </p>

      <PostCard post={post} signedIn={signedIn} permalink={permalink} />

      <section id="comments" className="mt-8 scroll-mt-20">
        <SectionHeading
          // The count is `posts.comment_count`, the trigger-maintained column, not
          // the length of the page that happened to be fetched.
          title={`Comments (${post.comment_count})`}
          description="A thread one reply deep. Replies to replies are not supported."
        />

        <div className="mt-4">
          {signedIn ? (
            <CommentComposer postId={post.id} autoFocus={false} />
          ) : (
            <p className="text-sm text-ink-muted">
              <Link
                href={`/login?next=${encodeURIComponent(`/post/${post.id}`)}`}
                className="text-accent-700 underline underline-offset-2"
              >
                Sign in
              </Link>{' '}
              to join the conversation.
            </p>
          )}
        </div>

        {comments.error ? (
          <Alert tone="danger" className="mt-6">
            {comments.error}
          </Alert>
        ) : null}

        <div className="mt-6">
          {topLevel.length > 0 ? (
            <>
              <CommentThread
                postId={post.id}
                comments={topLevel}
                replies={replies}
                signedIn={signedIn}
              />
              {moreCommentsHref ? (
                <LoadMore href={moreCommentsHref} label="Load more comments" />
              ) : (
                <EndOfList label="That is the whole thread." />
              )}
            </>
          ) : null}

          {!comments.error && topLevel.length === 0 ? (
            <EmptyState title="No comments yet">
              <p>
                This post has not been replied to. The first comment is usually the one that decides
                whether a thread happens.
              </p>
            </EmptyState>
          ) : null}
        </div>
      </section>
    </div>
  )
}
