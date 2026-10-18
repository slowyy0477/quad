'use client'

import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { statusLabel, type ChannelStatus } from './channel'

/**
 * The connection state, said out loud.
 *
 * Four states, four words, no spinner. A spinner on a socket that has quietly
 * died is the failure this replaces: the reader waits for a message that cannot
 * arrive. When the state is not `live` there is a real refresh control beside it,
 * because "the live connection is down" and "you can still read what is there"
 * are both true and the interface should say both.
 *
 * `role="status"` rather than `alert`: this changes while the reader is reading,
 * and it is worth announcing politely, not worth interrupting.
 *
 * Lives under `features/messages/components/` and is imported by the notifications
 * feature, which ARCHITECTURE §3 rule 2 permits explicitly (`components/**` is the
 * shared surface between domains) — the alternative was a second copy of the same
 * four sentences.
 */
export function ConnectionState({
  status,
  onRefresh,
  className,
}: {
  status: ChannelStatus
  onRefresh: () => void
  className?: string
}) {
  const live = status === 'live'

  return (
    <div className={cn('flex items-center gap-2 text-xs', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-success-600' : status === 'connecting' ? 'bg-ink-faint' : 'bg-warning-600',
        )}
      />
      <span role="status" aria-live="polite" className="text-ink-muted">
        {statusLabel(status)}
      </span>
      {!live ? (
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh} className="gap-1.5">
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
      ) : null}
    </div>
  )
}
