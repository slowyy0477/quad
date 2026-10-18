'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { BellOff, BellRing, CheckCheck, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  markConversationReadAction,
  setConversationMutedAction,
} from '@/features/messages/actions'

/**
 * The per-conversation actions: mark read, mute, unmute.
 *
 * Both are writes the reader's own grant permits — `last_read_at`/`is_muted` on
 * their own participant row, and `unread_count` only through the security-definer
 * function. Neither is optimistic: the control is set from what the action returns,
 * which is what the database holds after the write. A switch that flips and then
 * silently reverts is one of the few things worse than no switch.
 *
 * **Muting means notifications, not unread.** `app.notify_message` skips a muted
 * conversation, and `public.total_unread_messages()` excludes muted ones — but
 * `conversation_participants.unread_count` still increments, because it counts
 * messages this reader has not read, which is a fact about the conversation rather
 * than a preference. The menu says so, in the menu, because the difference between
 * "stop telling me" and "stop counting" is exactly the kind of thing a toggle lies
 * about by default.
 *
 * The message that appears after a refusal is rendered outside the menu, in the
 * row: a portalled menu that has already closed cannot carry it.
 */
export function ConversationActions({
  conversationId,
  isMuted,
  unreadCount,
}: {
  conversationId: string
  isMuted: boolean
  unreadCount: number
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(isMuted)
  const [lastMuted, setLastMuted] = useState(isMuted)
  const [pending, startTransition] = useTransition()

  // A fresh server render — after revalidatePath, or because another tab wrote —
  // changes this prop. Adjusting state during render is React's documented pattern
  // for that, and it is the alternative to an effect that calls setState, which is
  // an error in this configuration.
  if (lastMuted !== isMuted) {
    setLastMuted(isMuted)
    setMuted(isMuted)
  }

  function markRead() {
    setError(null)
    startTransition(async () => {
      const result = await markConversationReadAction(conversationId)
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  function toggleMute() {
    const next = !muted
    setError(null)
    startTransition(async () => {
      const result = await setConversationMutedAction(conversationId, next)
      if (result.ok) {
        setMuted(result.muted)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <div className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 min-h-9"
            aria-label="Conversation actions"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent>
          {unreadCount > 0 ? (
            <DropdownMenuItem onSelect={markRead}>
              <CheckCheck className="size-4" aria-hidden="true" />
              Mark as read
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuItem onSelect={toggleMute}>
            {muted ? (
              <>
                <BellRing className="size-4" aria-hidden="true" />
                Unmute notifications
              </>
            ) : (
              <>
                <BellOff className="size-4" aria-hidden="true" />
                Mute notifications
              </>
            )}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <p className="px-2.5 pb-1.5 text-2xs text-ink-faint">
            Muting stops being told about new messages here. The unread count still moves, because
            it counts messages you have not read.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      {pending ? (
        <span className="sr-only" role="status">
          Saving your change
        </span>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 max-w-40 text-2xs font-medium text-danger-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}
