// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { InviteResponseState, ProjectInvitation } from '../invitations'

const view = vi.hoisted(() => ({ state: { status: 'idle' } as InviteResponseState, pending: false }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useActionState: () => [view.state, () => undefined, view.pending],
}))
vi.mock('../invite-actions', () => ({ respondToProjectInviteAction: vi.fn() }))
import { InviteResponse } from './invite-response'

const invitation: ProjectInvitation = {
  id: 'pin_bob', projectId: 'prj_private', projectSlug: 'private-project', projectTitle: 'Private project',
  projectVisibility: 'private', message: 'Your private invitation.', proposedRole: 'Design',
  createdAt: '2026-10-20T00:00:00.000Z', canAccept: true, refusalReason: null,
}
beforeEach(() => { view.state = { status: 'idle' }; view.pending = false })
afterEach(cleanup)
describe('accessible invitation response controls', () => {
  it('offers real accept/decline submitters and posts only the invitation reference', () => {
    const { container } = render(<InviteResponse invitation={invitation} />)
    expect(screen.getByRole('heading', { name: 'Invitation to Private project' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toHaveAttribute('value', 'accepted')
    expect(screen.getByRole('button', { name: 'Decline invitation' })).toHaveAttribute('value', 'declined')
    expect(container.querySelector('input[name="inviteId"]')).toHaveAttribute('value', 'pin_bob')
    expect(container.querySelectorAll('input')).toHaveLength(1)
    expect(screen.getByText(/project stays private/)).toBeVisible()
  })
  it('announces pending work and disables both responses', () => {
    view.pending = true
    render(<InviteResponse invitation={invitation} />)
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline invitation' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Saving your response')
  })
  it('exposes accessible errors and preserves decline when capacity prevents joining', () => {
    view.state = { status: 'error', message: 'This project has reached its team size.' }
    render(<InviteResponse invitation={{ ...invitation, canAccept: false, refusalReason: 'full' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('reached its team size')
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline invitation' })).toBeEnabled()
  })
  it('shows a confirmed membership link and no repeat response buttons after acceptance', () => {
    view.state = { status: 'success', response: 'accepted', message: 'You are now a project member.', projectPath: '/projects/private-project' }
    render(<InviteResponse invitation={invitation} />)
    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute('href', '/projects/private-project')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('does not imply membership or offer a private project link after decline', () => {
    view.state = { status: 'success', response: 'declined', message: 'Invitation declined. You have not joined the project.' }
    render(<InviteResponse invitation={invitation} />)
    expect(screen.getByRole('status')).toHaveTextContent('not joined')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
