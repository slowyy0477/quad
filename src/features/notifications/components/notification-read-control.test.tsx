import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { markOneReadFormAction } from '@/features/notifications/actions'
import type { MarkReadOutcome } from '@/features/notifications/types'
import { NotificationReadControl } from './notification-read-control'

const actions = vi.hoisted(() => ({ read: vi.fn<typeof markOneReadFormAction>() }))
vi.mock('@/features/notifications/actions', () => ({ markOneReadFormAction: actions.read }))

beforeEach(() => {
  actions.read.mockReset()
  actions.read.mockResolvedValue({ ok: true, marked: 1 })
  // JSDOM has no layout; this supports the focus-selection seam only, not
  // geometry, viewport visibility, motion or target-size acceptance.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    const values = this.hidden ? [] : [new DOMRect(0, 0, 120, 44)]
    return Object.assign(values, { item: (index: number) => values[index] ?? null })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: (outcome: MarkReadOutcome) => void
  const promise = new Promise<MarkReadOutcome>(done => { resolve = done })
  return { promise, resolve }
}

function Fixture({
  isRead = false, ownLink = true, nextRow = false, overview = true,
}: { isRead?: boolean; ownLink?: boolean; nextRow?: boolean; overview?: boolean }) {
  return (
    <>
      <div data-header-menu={overview ? 'notifications' : undefined}>
        <ul>
          <li>
            <p data-notification-message tabIndex={-1}>Synthetic notification</p>
            {ownLink ? <a href="/messages?c=conversation_synthetic">Open the conversation</a> : null}
            <NotificationReadControl id="ntf_synthetic" isRead={isRead} />
          </li>
          {nextRow ? <li><a href="/connections/requests">See your requests</a></li> : null}
        </ul>
        {overview ? <a data-notification-overview href="/notifications">View all notifications</a> : null}
      </div>
      <button type="button">Outside action</button>
      <div data-testid="outside-text">Outside nonfocusable text</div>
    </>
  )
}

async function beginPendingRead() {
  const pending = deferred()
  actions.read.mockReturnValue(pending.promise)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Mark as read' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Marking as read…' })).toBeDisabled())
  return { pending, user }
}

describe('notification read control — mocked action/focus seam, not hosted or no-JavaScript acceptance', () => {
  it('posts the exact real id, disables repeat submission and waits for authoritative read state', async () => {
    const view = render(<Fixture />)
    const { pending, user } = await beginPendingRead()
    expect(actions.read).toHaveBeenCalledTimes(1)
    const [previous, data] = actions.read.mock.calls[0]
    expect(previous).toBeNull()
    expect(data.getAll('id')).toEqual(['ntf_synthetic'])
    await user.click(screen.getByRole('button', { name: 'Marking as read…' }))
    expect(actions.read).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    expect(await screen.findByRole('status')).toHaveTextContent('Notification marked as read.')
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeEnabled()
    view.rerender(<Fixture isRead />)
    expect(screen.queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('keeps a zero-change result distinct from a successful write and leaves the unread form', async () => {
    actions.read.mockResolvedValue({ ok: true, marked: 0 })
    render(<Fixture />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('No notification changed.')
    expect(screen.queryByText('Notification marked as read.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeEnabled()
  })

  it('announces a failed server outcome and permits a real retry without claiming a write', async () => {
    actions.read.mockResolvedValueOnce({ ok: false, message: 'Please try again.' })
    render(<Fixture />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again.')
    expect(screen.queryByText('Notification marked as read.')).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Mark as read' })
    expect(retry).toBeEnabled()
    await user.click(retry)
    expect(await screen.findByRole('status')).toHaveTextContent('Notification marked as read.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(2)
  })

  it('does not submit or take focus when already-read activity first mounts', () => {
    const view = render(<Fixture isRead />)
    expect(view.container.querySelector('form')).toBeNull()
    expect(actions.read).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Open the conversation' })).not.toHaveFocus()
  })

  it.each([
    [{ ownLink: true, nextRow: false, overview: true }, 'Open the conversation'],
    [{ ownLink: false, nextRow: true, overview: true }, 'See your requests'],
    [{ ownLink: false, nextRow: false, overview: true }, 'View all notifications'],
  ] as const)('hands accepted submit focus to a surviving destination (%s)', async (options, name) => {
    const view = render(<Fixture {...options} />)
    const { pending } = await beginPendingRead()
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    await screen.findByRole('status')
    view.rerender(<Fixture {...options} isRead />)
    await waitFor(() => expect(screen.getByRole('link', { name })).toHaveFocus())
  })

  it('retains a visible sentence focus destination on the full-page last row without a target', async () => {
    const view = render(<Fixture ownLink={false} overview={false} />)
    const { pending } = await beginPendingRead()
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    await screen.findByRole('status')
    view.rerender(<Fixture ownLink={false} overview={false} isRead />)
    await waitFor(() => expect(screen.getByText('Synthetic notification')).toHaveFocus())
  })

  it('does not steal outside focus while an accepted read is pending', async () => {
    const view = render(<Fixture />)
    const { pending, user } = await beginPendingRead()
    const outside = screen.getByRole('button', { name: 'Outside action' })
    await user.click(outside)
    expect(outside).toHaveFocus()
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    await screen.findByRole('status')
    view.rerender(<Fixture isRead />)
    expect(outside).toHaveFocus()
    expect(screen.getByRole('link', { name: 'Open the conversation' })).not.toHaveFocus()
  })

  it('does not restore submit focus after an outside nonfocusable pointer action', async () => {
    const view = render(<Fixture />)
    const { pending, user } = await beginPendingRead()
    await user.click(screen.getByTestId('outside-text'))
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    await screen.findByRole('status')
    view.rerender(<Fixture isRead />)
    expect(screen.getByRole('link', { name: 'Open the conversation' })).not.toHaveFocus()
  })

  it('ignores disabled destinations when finding the next control', async () => {
    const children = (read: boolean) => (
      <div data-header-menu="notifications">
        <ul>
          <li><NotificationReadControl id="ntf_synthetic" isRead={read} /></li>
          <li><button type="button" disabled>Unavailable control</button><a href="/me">Your profile</a></li>
        </ul>
        <a data-notification-overview href="/notifications">View all notifications</a>
      </div>
    )
    const view = render(children(false))
    const { pending } = await beginPendingRead()
    await act(async () => pending.resolve({ ok: true, marked: 1 }))
    await screen.findByRole('status')
    view.rerender(children(true))
    await waitFor(() => expect(within(view.container).getByRole('link', { name: 'Your profile' })).toHaveFocus())
  })
})
