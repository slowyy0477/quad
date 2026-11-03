import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormState } from '@/lib/form-state'
import type { ConversationPane, ConversationSummary, ThreadPage } from '../types'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  markRead: vi.fn(),
  mute: vi.fn(),
  leave: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/features/messages/actions', () => ({
  sendMessageAction: mocks.send,
  markConversationReadAction: mocks.markRead,
  setConversationMutedAction: mocks.mute,
  leaveConversationAction: mocks.leave,
}))
vi.mock('@/features/moderation/actions', () => ({ submitReportAction: vi.fn() }))
vi.mock('./thread-realtime', () => ({ ThreadRealtime: () => null }))
vi.mock('./new-conversation', () => ({ NewConversationForm: () => null }))

import { Thread } from './thread'
import { ConversationList } from './conversation-list'

const page: ThreadPage = { messages: [], olderCursor: null, hasOlder: false, error: null }
const instant = new Date('2026-10-31T09:30:00.000Z')

function pane(id: string): ConversationPane {
  return {
    id, type: 'group', title: `Synthetic thread ${id}`,
    other: null, unread_count: 0, is_muted: false, i_blocked: false,
    left: false, last_read_at: null,
  }
}

function view(id: string) {
  return <Thread pane={pane(id)} page={page} meId="synthetic-reader" hasCursor={false} now={instant} />
}

function keptDraft(id: string, body: string) {
  const clientNonce = randomUUID()
  const stored = JSON.stringify({ body, clientNonce })
  window.sessionStorage.setItem(`quad.messages.draft.${id}`, stored)
  return { body, clientNonce, stored }
}

function nonce(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[name="clientNonce"]')?.value
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockReset()
  mocks.send.mockResolvedValue({ status: 'success', message: 'Sent.' })
  mocks.markRead.mockResolvedValue({ ok: true, marked: true })
  mocks.leave.mockResolvedValue({ ok: true, left: true })
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('conversation-scoped action state and retained drafts', () => {
  it('does not clear another thread body/nonce when navigating after a successful send', async () => {
    const user = userEvent.setup()
    const first = randomUUID()
    const second = randomUUID()
    const kept = keptDraft(second, 'Synthetic second thread unfinished message')
    const { container, rerender } = render(view(first))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Synthetic first send')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(window.sessionStorage.getItem(`quad.messages.draft.${first}`)).toBeNull()

    rerender(view(second))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(kept.body))
    expect(nonce(container)).toBe(kept.clientNonce)
    expect(window.sessionStorage.getItem(`quad.messages.draft.${second}`)).toBe(kept.stored)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('isolates a late success after switching away from an in-flight send, losing neither draft', async () => {
    const user = userEvent.setup()
    const first = randomUUID()
    const second = randomUUID()
    const kept = keptDraft(second, 'Synthetic independent navigation draft')
    let finish!: (state: FormState) => void
    mocks.send.mockImplementationOnce(() => new Promise<FormState>(resolve => { finish = resolve }))
    const { container, rerender } = render(view(first))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Synthetic pending first send')
    const submittedNonce = nonce(container)
    const submittedDraft = window.sessionStorage.getItem(`quad.messages.draft.${first}`)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled())

    rerender(view(second))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(kept.body))
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    await act(async () => { finish({ status: 'success', message: 'Sent.' }) })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(kept.body)
    expect(nonce(container)).toBe(kept.clientNonce)
    expect(window.sessionStorage.getItem(`quad.messages.draft.${second}`)).toBe(kept.stored)

    // An unmounted action cannot clear a new composer. Its original nonce may
    // be retried on return, which is safe and covered by the durable-send tests.
    expect(window.sessionStorage.getItem(`quad.messages.draft.${first}`)).toBe(submittedDraft)
    rerender(view(first))
    await waitFor(() => expect(nonce(container)).toBe(submittedNonce))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Synthetic pending first send')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('retains a refused send across A/B/A navigation and retries the same conversation/body/nonce', async () => {
    const user = userEvent.setup()
    const first = randomUUID()
    const second = randomUUID()
    const kept = keptDraft(second, 'Synthetic unrelated kept text')
    mocks.send.mockResolvedValueOnce({ status: 'error', message: 'Synthetic refused send' })
    const { container, rerender } = render(view(first))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Synthetic retry after navigation')
    const submittedNonce = nonce(container)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Synthetic refused send')

    rerender(view(second))
    await waitFor(() => expect(nonce(container)).toBe(kept.clientNonce))
    expect(screen.queryByText('Synthetic refused send')).not.toBeInTheDocument()
    rerender(view(first))
    await waitFor(() => expect(nonce(container)).toBe(submittedNonce))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Synthetic retry after navigation')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(mocks.send.mock.calls.map(call => {
      const data = call[1] as FormData
      return [data.get('conversationId'), data.get('body'), data.get('clientNonce')]
    })).toEqual([
      [first, 'Synthetic retry after navigation', submittedNonce],
      [first, 'Synthetic retry after navigation', submittedNonce],
    ])
    expect(window.sessionStorage.getItem(`quad.messages.draft.${second}`)).toBe(kept.stored)
  })
})

describe('inbox membership controls', () => {
  it.each([false, true])('offers Leave only for an active inbox membership (left=%s)', async left => {
    const user = userEvent.setup()
    const id = randomUUID()
    const conversation: ConversationSummary = {
      ...pane(id), last_activity_at: instant.toISOString(),
      last_message_at: instant.toISOString(), last_message_preview: 'Synthetic retained history',
      others: [],
    }
    conversation.left = left
    render(<ConversationList conversations={[conversation]} selectedId={null} loadMoreHref={null} />)
    expect(screen.getByRole('link', { name: /Synthetic thread/ })).toHaveAttribute('href', `/messages?c=${id}`)
    screen.getByRole('button', { name: 'Conversation actions' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menuitem', { name: 'Mute notifications' })
    if (left) {
      expect(screen.queryByRole('menuitem', { name: 'Leave conversation' })).not.toBeInTheDocument()
      expect(screen.getByText('Only messages from your membership remain readable.')).toBeInTheDocument()
      expect(screen.getByText('You left', { exact: true })).toBeInTheDocument()
      expect(mocks.leave).not.toHaveBeenCalled()
    } else {
      await user.click(screen.getByRole('menuitem', { name: 'Leave conversation' }))
      await waitFor(() => expect(mocks.leave).toHaveBeenCalledWith(id))
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    }
  })
})
