import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationPane, ThreadMessage, ThreadPage } from '../types'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), redirect: vi.fn(),
  getUser: vi.fn(), list: vi.fn(), pane: vi.fn(), messages: vi.fn(),
  target: vi.fn(), permission: vi.fn(), send: vi.fn(), start: vi.fn(), create: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push, replace: mocks.replace }),
  redirect: mocks.redirect,
}))
vi.mock('@/lib/env', () => ({ isDataConfigured: () => true }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/supabase/server', () => ({ getUser: mocks.getUser }))
vi.mock('@/features/messages/queries', () => ({
  listConversations: mocks.list, getConversationPane: mocks.pane,
  listThreadMessages: mocks.messages, findMessagingTarget: mocks.target,
  getMessagingPermission: mocks.permission,
}))
vi.mock('@/features/messages/actions', () => ({
  startConversationAction: mocks.start, createGroupConversationAction: mocks.create,
  sendMessageAction: mocks.send, markConversationReadAction: vi.fn(),
  setConversationMutedAction: vi.fn(), leaveConversationAction: vi.fn(),
  addGroupMembersAction: vi.fn(), setGroupMemberRoleAction: vi.fn(), removeGroupMemberAction: vi.fn(),
}))
vi.mock('./thread-realtime', () => ({ ThreadRealtime: () => <span>Live</span> }))
vi.mock('./mark-conversation-read', () => ({
  MarkConversationRead: () => <span data-testid="mark-read" />,
}))
vi.mock('./message-bubble', () => ({
  DaySeparator: () => null, UnreadDivider: () => null,
  ParticipantName: () => <span>Synthetic peer</span>,
  MessageBubble: ({ message }: { message: ThreadMessage }) => <p>{message.body}</p>,
}))

import MessagesPage from '@/app/messages/page'
import { NewConversationForm } from './new-conversation'
import { Thread } from './thread'

const meId = randomUUID()
const peer = {
  id: randomUUID(), username: 'synthetic_route_peer', display_name: 'Synthetic peer', avatar_url: null,
}
const instant = new Date('2026-10-31T09:30:00.000Z')
const emptyPage: ThreadPage = { messages: [], olderCursor: null, hasOlder: false, error: null }
const message: ThreadMessage = {
  id: randomUUID(), sender_id: peer.id, body: 'Synthetic readable history',
  created_at: instant.toISOString(), is_edited: false, deleted_at: null,
  attachment_name: null, author: peer,
}
function pane(overrides: Partial<ConversationPane> = {}): ConversationPane {
  return {
    id: randomUUID(), type: 'direct', title: null, other: peer,
    reader_profile_id: meId, unread_count: 1, is_muted: false, i_blocked: false,
    left: false, last_read_at: null, ...overrides,
  }
}
function threadView(conversation: ConversationPane, page = emptyPage, hasCursor = false) {
  return <Thread pane={conversation} page={page} meId={meId} hasCursor={hasCursor} now={instant} />
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.redirect.mockImplementation(() => { throw new Error('Synthetic authentication redirect') })
  mocks.getUser.mockResolvedValue({ id: meId })
  mocks.list.mockResolvedValue({ conversations: [], nextCursor: null, error: null })
  mocks.pane.mockResolvedValue(null)
  mocks.target.mockResolvedValue(peer)
  mocks.permission.mockResolvedValue({ state: 'allowed' })
  window.sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('one authenticated creation surface', () => {
  it('prefills and opens one inbox form with unique IDs and correctly focused labels', async () => {
    const user = userEvent.setup()
    const { container } = render(await MessagesPage({ searchParams: Promise.resolve({ to: peer.username }) }))
    const handle = screen.getByRole('textbox', { name: /^Their handle/ })
    expect(handle).toHaveValue(peer.username)
    expect(screen.getByText('New message', { selector: 'summary' }).closest('details')).toHaveAttribute('open')
    await user.click(screen.getByText('Create group', { selector: 'summary' }))
    const fields = [
      handle, screen.getByRole('textbox', { name: /^Group name/ }),
      screen.getByRole('textbox', { name: /^Group handles/ }),
    ]
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(container.querySelectorAll('input[name="username"]')).toHaveLength(1)
    expect(container.querySelectorAll('input[name="title"]')).toHaveLength(1)
    for (const field of fields) {
      const label = container.querySelector(`label[for="${field.id}"]`)
      expect(label).not.toBeNull()
      await user.click(label as HTMLLabelElement)
      expect(field).toHaveFocus()
    }
  })

  it('keeps a refused target notice without prefilling/opening a refused creation form', async () => {
    mocks.permission.mockResolvedValue({ state: 'refused', reason: 'Synthetic incoming DM refusal.' })
    const { container } = render(await MessagesPage({ searchParams: Promise.resolve({ to: peer.username }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic incoming DM refusal.')
    expect(container.querySelector('input[name="username"]')).toHaveValue('')
    expect(screen.getByText('New message', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('opens and prefills a newly selected target even after the prior creation panel was closed', async () => {
    const user = userEvent.setup()
    const { rerender } = render(await MessagesPage({ searchParams: Promise.resolve({ to: peer.username }) }))
    await user.click(screen.getByText('New message', { selector: 'summary' }))
    expect(screen.getByText('New message', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open')
    const next = { ...peer, id: randomUUID(), username: 'synthetic_next_peer' }
    mocks.target.mockResolvedValue(next)
    rerender(await MessagesPage({ searchParams: Promise.resolve({ to: next.username }) }))
    expect(screen.getByText('New message', { selector: 'summary' }).closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('textbox', { name: /^Their handle/ })).toHaveValue(next.username)
  })

  it('keeps form/hint IDs unique even if another caller mounts two creation instances', () => {
    const { container } = render(<><NewConversationForm /><NewConversationForm /></>)
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(container.querySelectorAll('input[name="username"]')).toHaveLength(2)
    expect(container.querySelectorAll('input[name="title"]')).toHaveLength(2)
    expect(screen.getAllByRole('textbox', { name: /^Their handle/ })).toHaveLength(2)
  })

  it('preserves the signed-out redirect before reading conversations or rendering forms', async () => {
    mocks.getUser.mockResolvedValue(null)
    await expect(MessagesPage({ searchParams: Promise.resolve({ to: peer.username }) }))
      .rejects.toThrow('Synthetic authentication redirect')
    expect(mocks.redirect).toHaveBeenCalledWith('/login?next=/messages')
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.target).not.toHaveBeenCalled()
  })
})

describe('authorized error, empty and retry states', () => {
  it('renders an inbox error and retry, not an empty-inbox claim', async () => {
    const user = userEvent.setup()
    mocks.list.mockResolvedValue({ conversations: null, nextCursor: null, error: 'Synthetic inbox failure.' })
    render(await MessagesPage({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic inbox failure.')
    expect(screen.queryByText('No conversations to show')).not.toBeInTheDocument()
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry conversations' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each([{ messages: null }, { messages: [message] }])('does not treat a failed thread read as empty or populated ($messages)', async ({ messages }) => {
    const user = userEvent.setup()
    const conversation = pane()
    render(threadView(conversation, { ...emptyPage, messages, error: 'Synthetic thread failure.' }, true))
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic thread failure.')
    expect(screen.queryByText('No readable messages in this history')).not.toBeInTheDocument()
    expect(screen.queryByText('Synthetic readable history')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mark-read')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the newest messages' }))
      .toHaveAttribute('href', `/messages?c=${conversation.id}`)
    await user.click(screen.getByRole('button', { name: 'Retry messages' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('uses membership-scoped empty history without weakening departure (left=%s)', left => {
    render(threadView(pane({ left }), emptyPage, true))
    expect(screen.getByText('No readable messages in this history')).toBeVisible()
    expect(screen.getByText('Only messages from your membership intervals are included.')).toBeVisible()
    expect(screen.queryByText(/nothing has been sent/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('mark-read')).not.toBeInTheDocument()
    if (left) expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  })

  it('keeps the current cursors and composer body/nonce through retry and a successful re-read', async () => {
    const user = userEvent.setup()
    const conversation = pane()
    const clientNonce = randomUUID()
    const body = 'Synthetic draft kept through a read retry'
    const stored = JSON.stringify({ body, clientNonce })
    const draftKey = `quad.messages.draft.${conversation.id}`
    const route = `/messages?c=${conversation.id}&before=synthetic-before&cursor=synthetic-inbox`
    window.history.replaceState({}, '', route)
    window.sessionStorage.setItem(draftKey, stored)
    const { rerender } = render(threadView(conversation, { ...emptyPage, error: 'Synthetic read refusal.' }, true))
    const textbox = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(textbox).toHaveValue(body))
    await user.click(screen.getByRole('button', { name: 'Retry messages' }))
    expect(window.location.pathname + window.location.search).toBe(route)
    rerender(threadView(conversation, { ...emptyPage, messages: [message] }, true))
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(textbox)
    expect(textbox).toHaveValue(body)
    expect(textbox.closest('form')?.querySelector('input[name="clientNonce"]')).toHaveValue(clientNonce)
    expect(window.sessionStorage.getItem(draftKey)).toBe(stored)
    expect(screen.getByText('Synthetic readable history')).toBeVisible()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('offers an explicit member-controls retry even while the connection says Live', async () => {
    const user = userEvent.setup()
    render(threadView(pane({ type: 'group', title: 'Synthetic group', other: null, group: null })))
    expect(screen.getByText('Live')).toBeVisible()
    expect(screen.getByText('Member controls could not be loaded.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry member controls' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/^Members \(/)).not.toBeInTheDocument()
  })
})
