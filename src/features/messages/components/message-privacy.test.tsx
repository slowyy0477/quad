import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormState } from '@/lib/form-state'
import type { ConversationPane, ThreadPage } from '../types'

const mocks = vi.hoisted(() => ({
  local: false,
  refresh: vi.fn(),
  send: vi.fn(),
  markRead: vi.fn(),
  mute: vi.fn(),
  leave: vi.fn(),
  createClient: vi.fn(),
  rowEvent: null as ((payload: unknown) => void) | null,
  statusEvent: null as ((status: string) => void) | null,
  removeChannel: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => mocks.local }))
vi.mock('@/features/messages/actions', () => ({
  sendMessageAction: mocks.send,
  markConversationReadAction: mocks.markRead,
  setConversationMutedAction: mocks.mute,
  leaveConversationAction: mocks.leave,
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }))
vi.mock('@/features/moderation/actions', () => ({ submitReportAction: vi.fn() }))

import { MessageComposer } from './message-composer'
import { ThreadRealtime } from './thread-realtime'
import { Thread } from './thread'

let counter = 0
function conversationId() {
  counter += 1
  return `11111111-1111-4111-8111-${String(counter).padStart(12, '0')}`
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = false
  mocks.rowEvent = null
  mocks.statusEvent = null
  mocks.markRead.mockResolvedValue({ ok: true, marked: true })
  window.sessionStorage.clear()
  const channel = {
    on: vi.fn((_event: string, _filter: unknown, callback: (payload: unknown) => void) => {
      mocks.rowEvent = callback
      return channel
    }),
    subscribe: vi.fn((callback: (status: string) => void) => {
      mocks.statusEvent = callback
      return channel
    }),
  }
  mocks.createClient.mockReturnValue({
    channel: vi.fn(() => channel), removeChannel: mocks.removeChannel,
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('messaging durable retries and reconciliation', () => {
  it('keeps the same body/nonce after a failed send and clears them only on real success', async () => {
    const user = userEvent.setup()
    const id = conversationId()
    mocks.send.mockResolvedValueOnce({ status: 'error', message: 'Synthetic interrupted send' })
      .mockResolvedValueOnce({ status: 'success', message: 'Sent.' })
    const { container } = render(<MessageComposer conversationId={id} />)
    const textarea = screen.getByRole('textbox', { name: 'Message' })
    await user.type(textarea, 'synthetic retry body')
    const nonce = container.querySelector<HTMLInputElement>('input[name="clientNonce"]')!.value
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Synthetic interrupted send')
    expect(textarea).toHaveValue('synthetic retry body')
    expect(container.querySelector<HTMLInputElement>('input[name="clientNonce"]')!.value).toBe(nonce)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(mocks.send.mock.calls.map(call => (call[1] as FormData).get('clientNonce'))).toEqual([nonce, nonce])
    expect(window.sessionStorage.getItem(`quad.messages.draft.${id}`)).toBeNull()
  })

  it('freezes the submitted body/nonce and rejects keyboard duplicate submission while pending', async () => {
    const user = userEvent.setup()
    let finish!: (value: FormState) => void
    mocks.send.mockImplementation(() => new Promise<FormState>(resolve => { finish = resolve }))
    const { container } = render(<MessageComposer conversationId={conversationId()} />)
    const textarea = screen.getByRole('textbox', { name: 'Message' })
    await user.type(textarea, 'synthetic pending body')
    const nonce = container.querySelector<HTMLInputElement>('input[name="clientNonce"]')!.value
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(textarea).toBeDisabled())
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLInputElement>('input[name="clientNonce"]')!.value).toBe(nonce)
    await act(async () => { finish({ status: 'error', message: 'Synthetic refusal' }) })
    expect(textarea).toBeEnabled()
    expect(textarea).toHaveValue('synthetic pending body')
  })

  it('reconciles durable history after reconnect even when no row event was delivered', async () => {
    vi.useFakeTimers()
    render(<ThreadRealtime conversationId={conversationId()} readerProfileId={conversationId()} />)
    act(() => { mocks.statusEvent!('SUBSCRIBED') })
    act(() => { vi.advanceTimersByTime(400) })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    act(() => { mocks.statusEvent!('CHANNEL_ERROR') })
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    act(() => { mocks.statusEvent!('SUBSCRIBED') })
    act(() => { vi.advanceTimersByTime(400) })
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    expect(mocks.markRead).not.toHaveBeenCalled()
  })

  it('treats row payloads as coalesced signals and never renders or marks their raw content read', async () => {
    vi.useFakeTimers()
    render(<ThreadRealtime conversationId={conversationId()} readerProfileId={conversationId()} />)
    act(() => {
      mocks.rowEvent!({ new: { body: 'synthetic socket-only secret' } })
      mocks.rowEvent!({ new: { body: 'another raw row' } })
      vi.advanceTimersByTime(400)
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('synthetic socket-only secret')).not.toBeInTheDocument()
    expect(mocks.markRead).not.toHaveBeenCalled()
  })

  it('opens no socket in local mode and offers a real manual refresh', async () => {
    mocks.local = true
    const user = userEvent.setup()
    render(<ThreadRealtime conversationId="cnv_local" readerProfileId="prf_local" />)
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(mocks.createClient).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /refresh/i }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    { left: true, hasCursor: false },
    { left: false, hasCursor: true },
  ])('does not auto-mark inaccessible or older history read: %j', ({ left, hasCursor }) => {
    const pane: ConversationPane = {
      id: conversationId(), type: 'group', title: 'Synthetic retained group',
      other: null, unread_count: 1, is_muted: false, i_blocked: false, left,
      last_read_at: null, reader_profile_id: conversationId(),
    }
    const page: ThreadPage = { messages: [], olderCursor: null, hasOlder: false, error: null }
    render(<Thread pane={pane} page={page} meId="student" hasCursor={hasCursor} now={new Date('2026-10-31')} />)
    expect(mocks.markRead).not.toHaveBeenCalled()
    if (left) {
      // The departed reader watches only their own membership, never messages.
      expect(mocks.createClient).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
      expect(screen.getByText(/Messages sent while you were a participant/)).toBeInTheDocument()
    }
  })
})
