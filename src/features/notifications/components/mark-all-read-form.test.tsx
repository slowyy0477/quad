import { Component, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { markAllReadFormAction } from '@/features/notifications/actions'
import type { MarkReadOutcome } from '@/features/notifications/types'
import { MarkAllRead } from './mark-all-read'

const actions = vi.hoisted(() => ({
  read: vi.fn<typeof markAllReadFormAction>(),
  unstableRethrow: vi.fn<(error: unknown) => void>(),
}))

vi.mock('@/features/notifications/actions', () => ({ markAllReadFormAction: actions.read }))
vi.mock('next/navigation', () => ({ unstable_rethrow: actions.unstableRethrow }))

const PRIVATE_DIAGNOSTIC = 'SYNTHETIC_PRIVATE_BULK_FORM_DIAGNOSTIC'
const UNCONFIRMED = 'The read status could not be confirmed. Please try again.'
const FORM_NAME = 'Mark all notifications as read'
const caughtRoots = new Set<{ root: Root; container: HTMLDivElement }>()

/**
 * Testing Library 16.3's conditional onCaughtError type requires a nonoptional
 * RootOptions field, while React 19 correctly declares it optional. Use React's
 * actual typed root API for these error-boundary cases; no cast or suppression.
 */
function renderWithCaughtErrors(ui: ReactNode, caught: (error: unknown) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container, { onCaughtError: caught })
  caughtRoots.add({ root, container })
  act(() => root.render(ui))
  return {
    container,
    rerender(next: ReactNode) { act(() => root.render(next)) },
  }
}

beforeEach(() => {
  actions.read.mockReset()
  actions.unstableRethrow.mockReset()
  actions.read.mockResolvedValue({ ok: true, marked: 2 })
})

afterEach(() => {
  for (const { root, container } of caughtRoots) {
    act(() => root.unmount())
    container.remove()
  }
  caughtRoots.clear()
  cleanup()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: (outcome: MarkReadOutcome) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<MarkReadOutcome>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function Fixture({ unread = 17 }: { unread?: number }) {
  return (
    <>
      <span aria-label="Server unread badge">{unread}</span>
      <p data-testid="server-notification-row">Synthetic row from the server.</p>
      <MarkAllRead unread={unread} />
    </>
  )
}

async function beginPendingRead() {
  const request = deferred()
  actions.read.mockReturnValueOnce(request.promise)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Marking…' })).toBeDisabled())
  return { request, user }
}

describe('bulk read form — real React action-state with mocked Server Action, not no-JavaScript/browser acceptance', () => {
  it('uses a named native form and submit button, with no hidden identity, row ID or pretend count fields', () => {
    const { container } = render(<Fixture />)
    const form = screen.getByRole('form', { name: FORM_NAME })
    const button = screen.getByRole('button', { name: 'Mark all as read' })
    expect(form).toBeInstanceOf(HTMLFormElement)
    expect(form).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toBeEnabled()
    expect(button.closest('form')).toBe(form)
    expect(container.querySelectorAll('form')).toHaveLength(1)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(actions.read).not.toHaveBeenCalled()
  })

  it('does not submit or render a control/result for an initial authoritative zero', () => {
    render(<Fixture unread={0} />)
    expect(screen.queryByRole('form', { name: FORM_NAME })).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(actions.read).not.toHaveBeenCalled()
  })

  it('posts empty FormData, announces pending and refuses repeat click/native submit without optimistic badge/row edits', async () => {
    render(<Fixture />)
    const { request, user } = await beginPendingRead()
    const form = screen.getByRole('form', { name: FORM_NAME })
    const button = screen.getByRole('button', { name: 'Marking…' })
    expect(form).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Marking notifications as read…')
    expect(actions.read).toHaveBeenCalledTimes(1)
    const [previous, data] = actions.read.mock.calls[0]
    expect(previous).toBeNull()
    expect(data).toBeInstanceOf(FormData)
    expect([...data.entries()]).toEqual([])
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('17')
    expect(screen.getByTestId('server-notification-row')).toHaveTextContent('Synthetic row from the server.')

    await user.click(button)
    fireEvent.submit(form)
    expect(actions.read).toHaveBeenCalledTimes(1)

    await act(async () => request.resolve({ ok: true, marked: 3 }))
    expect(await screen.findByRole('status')).toHaveTextContent('3 marked as read.')
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('17')
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('also refuses a second native submission before the pending render commits', async () => {
    const request = deferred()
    actions.read.mockReturnValueOnce(request.promise)
    render(<Fixture />)
    const form = screen.getByRole('form', { name: FORM_NAME })
    const duplicate = new Event('submit', { bubbles: true, cancelable: true })

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(duplicate)
    })

    expect(duplicate.defaultPrevented).toBe(true)
    await waitFor(() => expect(actions.read).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Marking…' })).toBeDisabled()
    await act(async () => request.resolve({ ok: true, marked: 1 }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 marked as read.')
  })

  it('takes its success count from the settled server result, not the unread prop or a local decrement', async () => {
    actions.read.mockResolvedValue({ ok: true, marked: 4 })
    const view = render(<Fixture unread={99} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('4 marked as read.')
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('99')
    expect(screen.queryByText('99 marked as read.')).not.toBeInTheDocument()
    expect(screen.queryByText('95')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()

    view.rerender(<Fixture unread={0} />)
    expect(screen.queryByRole('form', { name: FORM_NAME })).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('4 marked as read.')
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('announces genuine zero without inventing a write and waits for authoritative badge reconciliation', async () => {
    actions.read.mockResolvedValue({ ok: true, marked: 0 })
    const view = render(<Fixture />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was unread.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/marked as read\./)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('17')
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()

    view.rerender(<Fixture unread={0} />)
    expect(screen.getByRole('status')).toHaveTextContent('Nothing was unread.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('keeps pending visible if an authoritative zero arrives before the action settles', async () => {
    const view = render(<Fixture />)
    const { request } = await beginPendingRead()
    view.rerender(<Fixture unread={0} />)
    expect(screen.getByRole('form', { name: FORM_NAME })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Marking…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Marking notifications as read…')

    await act(async () => request.resolve({ ok: true, marked: 0 }))
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was unread.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('announces a returned server failure as an alert, keeps a retry even if unread becomes zero, and never calls it success', async () => {
    actions.read.mockResolvedValueOnce({ ok: false, message: 'Sign in again to mark these as read.' })
    const view = render(<Fixture />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again to mark these as read.')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing was unread.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('17')

    view.rerender(<Fixture unread={0} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in again to mark these as read.')
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
    expect(actions.read).toHaveBeenCalledTimes(1)
  })

  it('retries a returned error through the real form, hiding the old alert while pending and replacing it with the new count', async () => {
    const failure: MarkReadOutcome = { ok: false, message: 'Please try again.' }
    actions.read.mockResolvedValueOnce(failure)
    render(<Fixture />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again.')

    const request = deferred()
    actions.read.mockReturnValueOnce(request.promise)
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Marking notifications as read…')
    expect(actions.read).toHaveBeenCalledTimes(2)
    expect(actions.read.mock.calls[1][0]).toEqual(failure)
    expect([...actions.read.mock.calls[1][1].entries()]).toEqual([])

    await act(async () => request.resolve({ ok: true, marked: 5 }))
    expect(await screen.findByRole('status')).toHaveTextContent('5 marked as read.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
  })

  it('clears earlier success feedback for a later pending/failing attempt and restores retry', async () => {
    actions.read.mockResolvedValueOnce({ ok: true, marked: 2 })
    render(<Fixture />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('2 marked as read.')

    const request = deferred()
    actions.read.mockReturnValueOnce(request.promise)
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(screen.queryByText('2 marked as read.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Marking notifications as read…')
    expect(actions.read.mock.calls[1][0]).toEqual({ ok: true, marked: 2 })

    await act(async () => request.resolve({ ok: false, message: UNCONFIRMED }))
    expect(await screen.findByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(screen.queryByText('2 marked as read.')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
  })

  it('contains a rejected client dispatch as a sanitized retryable alert, then remounts a fresh form without auto-resubmitting', async () => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    const caught = vi.fn<(error: unknown) => void>()
    actions.read.mockRejectedValueOnce(error)
    const view = renderWithCaughtErrors(<Fixture />, caught)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(caught).toHaveBeenCalled()
    expect(actions.unstableRethrow).toHaveBeenCalledWith(error)
    expect(view.container.innerHTML).not.toContain(PRIVATE_DIAGNOSTIC)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: FORM_NAME })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.getByLabelText('Server unread badge')).toHaveTextContent('17')
    expect(actions.read).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(actions.read).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('2 marked as read.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(2)
    expect(actions.read.mock.calls[1][0]).toEqual({ ok: false, message: UNCONFIRMED })
  })

  it('keeps a fresh retry form after a client rejection even when new authoritative props report zero', async () => {
    const caught = vi.fn<(error: unknown) => void>()
    actions.read.mockRejectedValueOnce(new Error(PRIVATE_DIAGNOSTIC))
    const view = renderWithCaughtErrors(<Fixture />, caught)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(UNCONFIRMED)
    view.rerender(<Fixture unread={0} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('form', { name: FORM_NAME })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled()
    expect(actions.read).toHaveBeenCalledTimes(1)

    actions.read.mockResolvedValueOnce({ ok: true, marked: 0 })
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was unread.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(2)
  })

  it('contains a pending promise rejection, permits repeated explicit retries and never reuses a failed hook queue', async () => {
    const first = deferred()
    const caught = vi.fn<(error: unknown) => void>()
    actions.read.mockReturnValueOnce(first.promise)
    const view = renderWithCaughtErrors(<Fixture />, caught)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(screen.getByRole('button', { name: 'Marking…' })).toBeDisabled()
    await act(async () => first.reject(new Error(PRIVATE_DIAGNOSTIC)))
    expect(await screen.findByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(view.container.textContent).not.toContain(PRIVATE_DIAGNOSTIC)

    actions.read.mockRejectedValueOnce(new Error(PRIVATE_DIAGNOSTIC))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(UNCONFIRMED)
    expect(actions.read).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).not.toContain(PRIVATE_DIAGNOSTIC)

    actions.read.mockResolvedValueOnce({ ok: true, marked: 0 })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was unread.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(actions.read).toHaveBeenCalledTimes(3)
  })

  it('forwards Next control-flow rejections to an outer boundary instead of rendering a retry failure', async () => {
    const controlFlow = new Error('Synthetic Next control-flow sentinel')
    const caught = vi.fn<(error: unknown) => void>()
    actions.unstableRethrow.mockImplementation(error => {
      if (error === controlFlow) throw error
    })
    actions.read.mockRejectedValueOnce(controlFlow)

    class OuterBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
      state: { error: unknown } = { error: null }

      static getDerivedStateFromError(error: unknown) { return { error } }

      render() {
        return this.state.error
          ? <p>Outer navigation handler</p>
          : this.props.children
      }
    }

    renderWithCaughtErrors(<OuterBoundary><Fixture /></OuterBoundary>, caught)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByText('Outer navigation handler')).toBeInTheDocument()
    expect(actions.unstableRethrow).toHaveBeenCalledWith(controlFlow)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(caught).toHaveBeenCalled()
  })
})
