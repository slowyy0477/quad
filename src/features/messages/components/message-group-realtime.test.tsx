import { act, cleanup, render, screen } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  local: false, refresh: vi.fn(), createClient: vi.fn(), removeChannel: vi.fn(),
}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => mocks.local }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }))

import { ThreadRealtime } from './thread-realtime'
import { scopedFilter, subscribeToRows } from './channel'

type Change = { event: string; table: string; filter: string }
type Socket = {
  filters: Change[]
  callbacks: ((payload: unknown) => void)[]
  status?: (status: string) => void
}
let sockets: Socket[]
const conversationId = randomUUID()
const readerId = randomUUID()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = false
  sockets = []
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.useFakeTimers()
  mocks.createClient.mockImplementation(() => ({
    channel: () => {
      const socket: Socket = { filters: [], callbacks: [] }
      sockets.push(socket)
      const channel = {
        on: (_kind: string, filter: Change, callback: (payload: unknown) => void) => {
          socket.filters.push(filter)
          socket.callbacks.push(callback)
          return channel
        },
        subscribe: (callback: (status: string) => void) => { socket.status = callback; return channel },
      }
      return channel
    },
    removeChannel: mocks.removeChannel,
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('authorized group change signals and durable reconciliation', () => {
  it('scopes message INSERT/UPDATE to the group and membership UPDATE to the actual reader, never DELETE/wildcard', () => {
    render(<ThreadRealtime conversationId={conversationId} readerProfileId={readerId} />)
    expect(sockets.flatMap(socket => socket.filters)).toEqual([
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      { event: 'UPDATE', schema: 'public', table: 'conversation_participants', filter: `profile_id=eq.${readerId}` },
    ])
    act(() => {
      for (const socket of sockets) for (const callback of socket.callbacks) callback({
        new: { body: 'Synthetic private socket body', deleted_at: 'synthetic-removal' },
      })
      vi.advanceTimersByTime(400)
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Synthetic private socket body')).not.toBeInTheDocument()
  })

  it('tears down messages on departure but retains only the reader-owned re-add/removal signal', () => {
    const { rerender } = render(<ThreadRealtime conversationId={conversationId} readerProfileId={readerId} />)
    rerender(<ThreadRealtime conversationId={conversationId} readerProfileId={readerId} active={false} />)
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(2)
    act(() => {
      sockets[1].callbacks[0]({ new: { left_at: null, body: 'Must not render this' } })
      vi.advanceTimersByTime(400)
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Must not render this')).not.toBeInTheDocument()
  })

  it('reconciles on reconnect and timer/focus without relying on a visible edit/removal socket payload', () => {
    const { unmount } = render(<ThreadRealtime conversationId={conversationId} readerProfileId={readerId} />)
    act(() => {
      sockets.forEach(socket => socket.status!('SUBSCRIBED'))
      vi.advanceTimersByTime(400)
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    act(() => {
      sockets.forEach(socket => socket.status!('CHANNEL_ERROR'))
      sockets.forEach(socket => socket.status!('SUBSCRIBED'))
      vi.advanceTimersByTime(400)
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(mocks.refresh).toHaveBeenCalledTimes(3)
    act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(400) })
    expect(mocks.refresh).toHaveBeenCalledTimes(4)
    unmount()
    act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(60_000) })
    expect(mocks.refresh).toHaveBeenCalledTimes(4)
    expect(mocks.removeChannel).toHaveBeenCalledTimes(2)
  })

  it('keeps local mode offline with no socket or hosted timer; foreground recovery may still refresh', () => {
    mocks.local = true
    render(<ThreadRealtime conversationId="cnv_synthetic" readerProfileId="prf_synthetic" />)
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(mocks.createClient).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(mocks.refresh).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(400) })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses private wildcard and wrong-owner-column subscriptions instead of opening an unsafe channel', () => {
    for (const [table, filter, events] of [
      ['messages', scopedFilter('conversation_id', conversationId), '*'],
      ['conversation_participants', scopedFilter('conversation_id', conversationId), 'UPDATE'],
    ] as const) {
      expect(() => subscribeToRows({
        channelName: `synthetic:${conversationId}`, table, filter, events,
        onEvent: vi.fn(), onStatus: vi.fn(),
      })).toThrow(/table-specific owner scope/)
    }
    expect(mocks.createClient).not.toHaveBeenCalled()
  })
})
