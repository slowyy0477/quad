import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupManagementPane, GroupMember } from '../types'
import { FINAL_GROUP_ADMIN_COPY, GROUP_REACHABILITY_COPY } from '../group-contract'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), add: vi.fn(), role: vi.fn(), remove: vi.fn(),
  start: vi.fn(), leave: vi.fn(), mute: vi.fn(), markRead: vi.fn(), refresh: vi.fn(),
}))
vi.mock('@/features/messages/actions', () => ({
  createGroupConversationAction: mocks.create,
  addGroupMembersAction: mocks.add,
  setGroupMemberRoleAction: mocks.role,
  removeGroupMemberAction: mocks.remove,
  startConversationAction: mocks.start,
  leaveConversationAction: mocks.leave,
  setConversationMutedAction: mocks.mute,
  markConversationReadAction: mocks.markRead,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { NewConversationForm } from './new-conversation'
import { GroupMembers } from './group-members'
import { ConversationActions } from './conversation-actions'

const aliceId = randomUUID()
const bobId = randomUUID()
const conversationId = randomUUID()
const alice: GroupMember = {
  profile_id: aliceId, role: 'admin', left: false, available: true,
  profile: { id: aliceId, username: 'synthetic_alice', display_name: 'Synthetic Alice', avatar_url: null },
}
const bob: GroupMember = {
  profile_id: bobId, role: 'member', left: false, available: true,
  profile: { id: bobId, username: 'synthetic_bob', display_name: 'Synthetic Bob', avatar_url: null },
}
function group(overrides: Partial<GroupManagementPane> = {}): GroupManagementPane {
  return { role: 'admin', active_count: 2, admin_count: 1, recorded_count: 2, has_more: false, members: [alice, bob], ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockReset()
  mocks.add.mockReset()
  mocks.role.mockResolvedValue({ ok: true, message: 'Member role saved.' })
  mocks.remove.mockResolvedValue({ ok: true, message: 'Member removed.' })
  mocks.leave.mockResolvedValue({ ok: true, left: true })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('collapsed, truthful group forms', () => {
  it('keeps Create group collapsed, displays its consent rule, retains refused inputs and links a counted success', async () => {
    const user = userEvent.setup()
    mocks.create.mockResolvedValueOnce({ status: 'error', message: 'No one was added, so no group was created.' })
      .mockResolvedValueOnce({
        status: 'success', conversationId, message: 'Group created. 1 person added. 1 not added.',
      })
    render(<NewConversationForm />)
    expect(screen.getByRole('textbox', { name: /^Group name/ })).not.toBeVisible()
    expect(screen.getByText('Create group', { selector: 'summary' }).parentElement).not.toHaveAttribute('open')
    await user.click(screen.getByText('Create group', { selector: 'summary' }))
    expect(screen.getByText(GROUP_REACHABILITY_COPY)).toBeVisible()
    const title = screen.getByRole('textbox', { name: /^Group name/ })
    const handles = screen.getByRole('textbox', { name: /^Group handles/ })
    await user.type(title, 'Synthetic study group')
    await user.type(handles, 'synthetic_bob, absent_student')
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no group was created')
    expect(title).toHaveValue('Synthetic study group')
    expect(handles).toHaveValue('synthetic_bob, absent_student')
    expect(screen.queryByRole('link', { name: 'Open group' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 person added. 1 not added.')
    expect(screen.getByRole('link', { name: 'Open group' })).toHaveAttribute('href', `/messages?c=${conversationId}`)
    expect(mocks.create.mock.calls.map(call => {
      const data = call[1] as FormData
      return [data.get('title'), data.get('handles')]
    })).toEqual([
      ['Synthetic study group', 'synthetic_bob, absent_student'],
      ['Synthetic study group', 'synthetic_bob, absent_student'],
    ])
  })

  it('keeps member and Add people controls collapsed and retains a zero-add/refused candidate list', async () => {
    const user = userEvent.setup()
    mocks.add.mockResolvedValue({ status: 'error', message: '0 people added. 1 not added.' })
    render(<GroupMembers conversationId={conversationId} group={group()} />)
    for (const control of screen.getAllByRole('combobox')) expect(control).not.toBeVisible()
    expect(screen.getByText('Members (2)', { selector: 'summary' }).parentElement).not.toHaveAttribute('open')
    await user.click(screen.getByText('Members (2)', { selector: 'summary' }))
    expect(screen.getByText(FINAL_GROUP_ADMIN_COPY)).toBeVisible()
    expect(screen.getByRole('textbox', { name: /^Handles to add/ })).not.toBeVisible()
    await user.click(screen.getByText('Add people', { selector: 'summary' }))
    const handles = screen.getByRole('textbox', { name: /^Handles to add/ })
    await user.type(handles, 'not_reachable')
    await user.click(screen.getByRole('button', { name: 'Add people' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('0 people added. 1 not added.')
    expect(handles).toHaveValue('not_reachable')
    expect((mocks.add.mock.calls[0][1] as FormData).get('conversationId')).toBe(conversationId)
  })

  it('offers current admins explicit Re-add and preserves a refusal instead of pretending membership changed', async () => {
    const user = userEvent.setup()
    mocks.add.mockResolvedValueOnce({ status: 'error', message: '0 people added. 1 not added.' })
      .mockResolvedValueOnce({ status: 'success', message: '1 person added.' })
    render(<GroupMembers conversationId={conversationId} group={group({
      active_count: 1, members: [alice, { ...bob, left: true }],
    })} />)
    await user.click(screen.getByText('Members (1)', { selector: 'summary' }))
    await user.click(screen.getByRole('button', { name: 'Re-add Synthetic Bob' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('0 people added.')
    expect(screen.getByText('Left', { exact: true })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Re-add Synthetic Bob' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 person added.')
    expect(mocks.add.mock.calls.map(call => {
      const data = call[1] as FormData
      return [data.get('conversationId'), data.get('handles')]
    })).toEqual([[conversationId, bob.profile!.username], [conversationId, bob.profile!.username]])
  })

  it('shows real role controls only to admins, prevents final-admin demotion and submits the chosen member role', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GroupMembers conversationId={conversationId} group={group()} />)
    await user.click(screen.getByText('Members (2)', { selector: 'summary' }))
    expect(screen.getByRole('combobox', { name: 'Role for Synthetic Alice' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove Synthetic Alice' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Synthetic Bob' }), 'admin')
    await user.click(screen.getByRole('button', { name: 'Save role for Synthetic Bob' }))
    await waitFor(() => expect(mocks.role).toHaveBeenCalledWith(conversationId, bobId, 'admin'))
    expect(await screen.findByRole('status')).toHaveTextContent('Member role saved.')
    rerender(<GroupMembers conversationId={conversationId} group={group({ role: 'member' })} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(screen.queryByText('Add people', { selector: 'summary' })).not.toBeInTheDocument()
  })

  it('does not expose the unavailable legacy member handle through a fallback control', async () => {
    const user = userEvent.setup()
    render(<GroupMembers conversationId={conversationId} group={group({
      role: 'member', admin_count: 0, members: [{ ...bob, profile: null, available: false }],
    })} />)
    await user.click(screen.getByText('Members (2)', { selector: 'summary' }))
    expect(screen.getByRole('status')).toHaveTextContent('legacy roles are not guessed')
    expect(screen.getByText('A student')).toBeVisible()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Re-add / })).not.toBeInTheDocument()
  })

  it('lets an active admin confirm removal of an unavailable member without offering a role change', async () => {
    const user = userEvent.setup()
    mocks.remove.mockResolvedValueOnce({ ok: false, message: 'Synthetic membership changed. Refresh before retrying.' })
    render(<GroupMembers conversationId={conversationId} group={group({ members: [alice, { ...bob, available: false }] })} />)
    await user.click(screen.getByText('Members (2)', { selector: 'summary' }))
    expect(screen.queryByRole('combobox', { name: 'Role for Synthetic Bob' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic Bob' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Synthetic Bob from group?' })
    expect(mocks.remove).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove Synthetic Bob' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Refresh before retrying')
    expect(mocks.remove).toHaveBeenCalledWith(conversationId, bobId)
    expect(dialog).toBeVisible()
  })

  it('explains final-admin Leave refusal in the menu without invoking a write', async () => {
    const user = userEvent.setup()
    render(<ConversationActions conversationId={conversationId} isMuted={false} unreadCount={0}
      leaveBlockedReason={FINAL_GROUP_ADMIN_COPY} />)
    screen.getByRole('button', { name: 'Conversation actions' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: 'Leave conversation' }))
      .toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(FINAL_GROUP_ADMIN_COPY)).toBeVisible()
    expect(mocks.leave).not.toHaveBeenCalled()
  })
})
