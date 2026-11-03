import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationPane, GroupChangeOutcome, GroupManagementPane, GroupMember, ThreadPage } from '../types'

const mocks = vi.hoisted(() => ({ role: vi.fn(), add: vi.fn(), remove: vi.fn() }))
vi.mock('@/features/messages/actions', () => ({
  setGroupMemberRoleAction: mocks.role, addGroupMembersAction: mocks.add, removeGroupMemberAction: mocks.remove,
  markConversationReadAction: vi.fn(), setConversationMutedAction: vi.fn(), leaveConversationAction: vi.fn(),
}))
vi.mock('@/features/moderation/actions', () => ({ submitReportAction: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('./thread-realtime', () => ({ ThreadRealtime: () => null }))
vi.mock('./mark-conversation-read', () => ({ MarkConversationRead: () => null }))
vi.mock('./message-composer', () => ({
  MessageComposer: () => <textarea aria-label="Synthetic thread draft" />,
}))

import { GroupMembers } from './group-members'
import { Thread } from './thread'

const conversationId = randomUUID()
function member(name: string, role: 'admin' | 'member'): GroupMember {
  const id = randomUUID()
  return {
    profile_id: id, role, left: false, available: true,
    profile: { id, username: `synthetic_${name.toLowerCase()}`, display_name: `Synthetic ${name}`, avatar_url: null },
  }
}
const alice = member('Alice', 'admin')
const bob = member('Bob', 'member')
const carol = member('Carol', 'member')
function group(overrides: Partial<GroupManagementPane> = {}): GroupManagementPane {
  return {
    role: 'admin', active_count: 3, admin_count: 1, recorded_count: 3,
    has_more: false, members: [alice, bob, carol], ...overrides,
  }
}
function view(value = group()) {
  return <GroupMembers conversationId={conversationId} group={value} />
}
function membersSummary() {
  return screen.getByText(/^Members \(/, { selector: 'summary' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role.mockReset().mockResolvedValue({ ok: true, message: 'Member role saved.' })
  mocks.add.mockReset().mockResolvedValue({ status: 'success', message: '1 person added.' })
  mocks.remove.mockReset().mockResolvedValue({ ok: true, message: 'Member removed. Their permitted history remains readable.' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('durable group-control feedback and focus', () => {
  it('keeps role success across changed props and collapse, preserving other unsaved fields', async () => {
    const user = userEvent.setup()
    const { rerender } = render(view())
    await user.click(membersSummary())
    await user.click(screen.getByText('Add people', { selector: 'summary' }))
    const handles = screen.getByRole('textbox', { name: /^Handles to add/ })
    await user.type(handles, 'synthetic_next_peer')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Carol' }), 'admin')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' }), 'admin')
    await user.click(screen.getByRole('button', { name: 'Save role for Synthetic Bob' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Member role saved.')
    rerender(view(group({ admin_count: 2, members: [alice, { ...bob, role: 'admin' }, carol] })))
    expect(screen.getByRole('status')).toHaveTextContent('Member role saved.')
    expect(screen.getByRole('status').closest('details')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Carol' })).toHaveValue('admin')
    expect(screen.getByRole('textbox', { name: /^Handles to add/ })).toBe(handles)
    expect(handles).toHaveValue('synthetic_next_peer')
    expect(screen.getByRole('button', { name: 'Save role for Synthetic Bob' })).toBeDisabled()
    await waitFor(() => expect(membersSummary()).toHaveFocus())
    await user.click(membersSummary())
    expect(screen.getByRole('status')).toBeVisible()
    expect(mocks.role).toHaveBeenCalledWith(conversationId, bob.profile_id, 'admin')
  })

  it('synchronizes an externally changed durable role without resetting a different member choice', async () => {
    const user = userEvent.setup()
    const { rerender } = render(view())
    await user.click(membersSummary())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Carol' }), 'admin')
    rerender(view(group({ admin_count: 2, members: [alice, { ...bob, role: 'admin' }, carol] })))
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' })).toHaveValue('admin')
    expect(screen.getByRole('button', { name: 'Save role for Synthetic Bob' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Carol' })).toHaveValue('admin')
    expect(mocks.role).not.toHaveBeenCalled()
  })

  it('keeps a re-add outcome after its departed-only form disappears and restores focus', async () => {
    const user = userEvent.setup()
    const { rerender } = render(view(group({ active_count: 2, members: [alice, { ...bob, left: true }, carol] })))
    await user.click(membersSummary())
    await user.click(screen.getByRole('button', { name: 'Re-add Synthetic Bob' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 person added.')
    rerender(view())
    expect(screen.getByRole('status')).toHaveTextContent('1 person added.')
    expect(screen.queryByRole('button', { name: 'Re-add Synthetic Bob' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' })).toHaveValue('member')
    await waitFor(() => expect(membersSummary()).toHaveFocus())
  })

  it('keeps confirmed removal success after durable departure and recovers modal-trigger focus', async () => {
    const user = userEvent.setup()
    const { rerender } = render(view())
    await user.click(membersSummary())
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic Bob' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Synthetic Bob from group?' })
    expect(mocks.remove).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove Synthetic Bob' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Member removed.')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    rerender(view(group({ active_count: 2, members: [alice, { ...bob, left: true }, carol] })))
    expect(screen.getByRole('status')).toHaveTextContent('Their permitted history remains readable.')
    expect(screen.queryByRole('button', { name: 'Remove Synthetic Bob' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-add Synthetic Bob' })).toBeVisible()
    await waitFor(() => expect(membersSummary()).toHaveFocus())
  })

  it('retains self-demotion success while removing all admin controls and recovering focus', async () => {
    const user = userEvent.setup()
    const initial = group({ admin_count: 2, members: [alice, { ...bob, role: 'admin' }, carol] })
    const { rerender } = render(view(initial))
    await user.click(membersSummary())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Alice' }), 'member')
    await user.click(screen.getByRole('button', { name: 'Save role for Synthetic Alice' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Member role saved.')
    rerender(view(group({
      role: 'member', admin_count: 1, members: [{ ...alice, role: 'member' }, { ...bob, role: 'admin' }, carol],
    })))
    expect(screen.getByRole('status')).toHaveTextContent('Member role saved.')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(screen.queryByText('Add people', { selector: 'summary' })).not.toBeInTheDocument()
    await waitFor(() => expect(membersSummary()).toHaveFocus())
  })

  it('allows a fresh removal confirmation after the same stable row is removed and re-added', async () => {
    const user = userEvent.setup()
    const { rerender } = render(view())
    await user.click(membersSummary())
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic Bob' }))
    const first = await screen.findByRole('dialog', { name: 'Remove Synthetic Bob from group?' })
    await user.click(within(first).getByRole('button', { name: 'Remove Synthetic Bob' }))
    await screen.findByRole('status')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    rerender(view(group({ active_count: 2, members: [alice, { ...bob, left: true }, carol] })))
    await user.click(screen.getByRole('button', { name: 'Re-add Synthetic Bob' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 person added.'))
    rerender(view())
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic Bob' }))
    expect(await screen.findByRole('dialog', { name: 'Remove Synthetic Bob from group?' })).toBeVisible()
    expect(mocks.remove).toHaveBeenCalledTimes(1)
  })

  it('focuses the same thread heading when own removal replaces the entire member panel with retained history', async () => {
    const user = userEvent.setup()
    const initial: ConversationPane = {
      id: conversationId, type: 'group', title: 'Synthetic owned group', other: null,
      reader_profile_id: alice.profile_id, unread_count: 0, is_muted: false, i_blocked: false,
      left: false, last_read_at: null,
      group: group({ admin_count: 2, members: [alice, { ...bob, role: 'admin' }, carol] }),
    }
    const page: ThreadPage = { messages: [], olderCursor: null, hasOlder: false, error: null }
    const thread = (value: ConversationPane) => (
      <Thread pane={value} page={page} meId={alice.profile_id} hasCursor={false}
        now={new Date('2026-10-31T09:30:00.000Z')} />
    )
    const { rerender } = render(thread(initial))
    await user.click(membersSummary())
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic Alice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Synthetic Alice from group?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove Synthetic Alice' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    rerender(thread({ ...initial, left: true, group: null }))
    expect(screen.getByText('You left this conversation')).toBeVisible()
    expect(screen.queryByText(/^Members \(/, { selector: 'summary' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Synthetic thread draft' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Synthetic owned group' })).toHaveFocus())
  })

  it('does not steal focus or a draft chosen outside the group during a pending role action', async () => {
    const user = userEvent.setup()
    let finish!: (result: GroupChangeOutcome) => void
    mocks.role.mockImplementation(() => new Promise<GroupChangeOutcome>(resolve => { finish = resolve }))
    const outside = <textarea aria-label="Synthetic outside draft" />
    const { rerender } = render(<>{view()}{outside}</>)
    await user.click(membersSummary())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' }), 'admin')
    await user.click(screen.getByRole('button', { name: 'Save role for Synthetic Bob' }))
    await waitFor(() => expect(mocks.role).toHaveBeenCalledTimes(1))
    const draft = screen.getByRole('textbox', { name: 'Synthetic outside draft' })
    await user.type(draft, 'Synthetic independently kept draft')
    await act(async () => { finish({ ok: true, message: 'Member role saved.' }) })
    rerender(<>{view(group({ admin_count: 2, members: [alice, { ...bob, role: 'admin' }, carol] }))}{outside}</>)
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('Synthetic independently kept draft')
    expect(screen.getByRole('status')).toHaveTextContent('Member role saved.')
  })

  it('keeps a truthful refusal and retry choice through a refresh without claiming a changed role', async () => {
    const user = userEvent.setup()
    mocks.role.mockResolvedValue({ ok: false, message: 'Synthetic current-admin refusal.' })
    const { rerender } = render(view())
    await user.click(membersSummary())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' }), 'admin')
    await user.click(screen.getByRole('button', { name: 'Save role for Synthetic Bob' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic current-admin refusal.')
    rerender(view(group()))
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic current-admin refusal.')
    expect(screen.queryByText('Member role saved.')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' })).toHaveValue('admin')
    expect(screen.getByRole('button', { name: 'Save role for Synthetic Bob' })).toBeEnabled()
    expect(within(screen.getByRole('link', { name: 'Synthetic Bob' }).closest('li') as HTMLLIElement)
      .getByText('Member', { exact: true, selector: 'span' })).toBeVisible()
  })
})
