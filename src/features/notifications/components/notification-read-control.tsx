'use client'

import { useActionState, useEffect, useLayoutEffect, useRef } from 'react'
import { markOneReadFormAction } from '@/features/notifications/actions'
import type { MarkReadOutcome } from '@/features/notifications/types'

function visibleControls(root: Element) {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href], button')).filter(element =>
    element.tabIndex >= 0 && !element.matches(':disabled') &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0,
  )
}

function afterReadTarget(root: HTMLElement): HTMLElement | null {
  const row = root.closest('li')
  const ownLink = row ? visibleControls(row).find(element => element.tagName === 'A') : null
  if (ownLink) return ownLink
  for (let next = row?.nextElementSibling; next; next = next.nextElementSibling) {
    const control = visibleControls(next)[0]
    if (control) return control
  }
  const panel = root.closest('[data-header-menu="notifications"]')
  const overview = panel?.querySelector<HTMLElement>('[data-notification-overview]')
  if (overview && visibleControls(panel!).includes(overview)) return overview
  return row?.querySelector<HTMLElement>('[data-notification-message]') ?? null
}

/**
 * No optimistic read/count changes. The server authorizes every submission and
 * authoritative isRead removes the form. Retain focus only for our own submit.
 */
export function NotificationReadControl({ id, isRead }: { id: string; isRead: boolean }) {
  const [outcome, formAction, pending] = useActionState<MarkReadOutcome | null, FormData>(
    markOneReadFormAction, null, '/notifications',
  )
  const root = useRef<HTMLDivElement>(null)
  const heldFocus = useRef(false)

  useEffect(() => {
    if (isRead && !pending) return
    function movedFocus(event: FocusEvent) {
      // Removing/disabling a focused submit may temporarily focus body. Only an
      // actual surviving outside focus destination cancels our handoff.
      if (event.target instanceof Node && event.target !== document.body &&
        !root.current?.contains(event.target)) heldFocus.current = false
    }
    function outsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        heldFocus.current = false
      }
    }
    document.addEventListener('focusin', movedFocus)
    document.addEventListener('pointerdown', outsidePointer)
    return () => {
      document.removeEventListener('focusin', movedFocus)
      document.removeEventListener('pointerdown', outsidePointer)
    }
  }, [isRead, pending])

  useLayoutEffect(() => {
    if (pending || !heldFocus.current || !root.current) return
    const active = document.activeElement
    if (active && active !== document.body && !root.current.contains(active)) {
      heldFocus.current = false
      return
    }
    if (isRead) {
      const target = afterReadTarget(root.current)
      heldFocus.current = false
      target?.focus({ preventScroll: true })
    } else if (outcome && active === document.body) {
      root.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
  }, [isRead, outcome, pending])

  const message = outcome ? outcome.ok
    ? outcome.marked > 0 ? 'Notification marked as read.' : 'No notification changed.'
    : outcome.message : null

  return (
    <div ref={root} className="inline-flex flex-col items-start gap-1">
      {isRead ? (
        outcome?.ok && outcome.marked > 0 ? <span role="status" className="sr-only">{message}</span> : null
      ) : (
        <>
          <form action={formAction} onSubmit={event => {
            if (pending) {
              event.preventDefault()
              return
            }
            heldFocus.current = Boolean(root.current?.contains(document.activeElement))
          }}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={pending} aria-disabled={pending}
              className="inline-flex min-h-11 items-center text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline disabled:opacity-60">
              {pending ? 'Marking as read…' : 'Mark as read'}
            </button>
          </form>
          {message ? <span role={outcome?.ok ? 'status' : 'alert'}
            className={`text-xs ${outcome?.ok ? 'text-ink-muted' : 'text-danger-700'}`}>{message}</span> : null}
        </>
      )}
    </div>
  )
}
