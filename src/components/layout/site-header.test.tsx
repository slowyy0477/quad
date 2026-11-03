import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '@/components/ui/avatar'
import type { SessionUser } from '@/lib/supabase/server'
import type { HeaderMenusProps } from './header-menus'
import { SiteHeader } from './site-header'

const boundary = vi.hoisted(() => ({ capture: vi.fn<(props: HeaderMenusProps) => void>() }))
const preview = vi.hoisted(() => ({ render: vi.fn<() => ReactElement>() }))
const auth = vi.hoisted(() => ({ signOutAction: vi.fn(async () => {}) }))
const deployment = vi.hoisted(() => ({ configured: true, local: false }))

vi.mock('server-only', () => ({}))
vi.mock('@/components/layout/header-menus', () => ({
  HeaderMenus: (props: HeaderMenusProps) => {
    boundary.capture(props)
    return null
  },
}))
vi.mock('@/components/layout/notification-header-preview', () => ({
  // Vitest cannot mount async RSCs. This seam covers server slot construction,
  // not Flight serialization, query authorization, hosted reads or streaming.
  NotificationHeaderPreview: preview.render,
}))
vi.mock('@/features/auth/actions', () => auth)
vi.mock('@/lib/env', () => ({ isDataConfigured: () => deployment.configured }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => deployment.local }))
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) => (
    <a {...props} href={href} data-prefetch={prefetch === false ? 'off' : undefined}>{children}</a>
  ),
}))

const student: SessionUser = {
  id: 'SYNTHETIC_PRIVATE_SESSION_USER_ID',
  email: 'SYNTHETIC_PRIVATE_EMAIL@example.invalid',
  user_metadata: {
    display_name: 'Ada Student',
    avatar_url: null,
    private_note: 'SYNTHETIC_PRIVATE_METADATA_DO_NOT_SERIALIZE',
    staff_role: 'admin', // Untrusted metadata never grants a staff destination.
  },
}

beforeEach(() => {
  boundary.capture.mockClear()
  preview.render.mockReset()
  preview.render.mockReturnValue(<p>Authorized preview fixture.</p>)
  auth.signOutAction.mockClear()
  deployment.configured = true
  deployment.local = false
})

afterEach(cleanup)

function prepared() {
  const props = boundary.capture.mock.calls.at(-1)?.[0]
  expect(props).toBeDefined()
  if (!props) throw new Error('The signed-in header did not prepare its client slots.')
  return props
}

function avatarSlot(props: HeaderMenusProps) {
  const trigger = props.profileTrigger as ReactElement<{ children: ReactElement<ComponentProps<typeof Avatar>> }>
  expect(trigger.type).toBe('span')
  expect(trigger.props.children.type).toBe(Avatar)
  return trigger.props.children
}

describe('server header wiring — boundary unit coverage, not Flight/hosted acceptance', () => {
  it('passes presentation slots and the unread label, never a SessionUser or role flags', () => {
    render(<SiteHeader user={student} />)
    const props = prepared()
    expect(Object.keys(props).sort()).toEqual([
      'campusFooter', 'campusStaffLink', 'notificationContent', 'notificationLabel',
      'notificationTrigger', 'profileContent', 'profileTrigger',
    ])
    expect(props).not.toHaveProperty('user')
    expect(props).not.toHaveProperty('staffRole')
    expect(props).not.toHaveProperty('email')
    expect(props.campusStaffLink).toBeNull()
    expect(avatarSlot(props).props).toEqual({ name: 'Ada Student', src: null, size: 'sm' })
    const notificationSlot = props.notificationContent as ReactElement
    expect(notificationSlot.type).toBe(preview.render)
    expect(notificationSlot.props).toEqual({})

    // React 19 development elements carry an enumerable _owner/Fiber. Do not
    // JSON-stringify ReactNodes and mistake a cycle or test-only owner for Flight.
    const { container } = render(
      <>{props.profileTrigger}{props.profileContent}{props.notificationTrigger}{props.campusFooter}</>,
    )
    expect(container.innerHTML).not.toContain(student.id)
    expect(container.innerHTML).not.toContain(student.email)
    expect(container.innerHTML).not.toContain('SYNTHETIC_PRIVATE_METADATA_DO_NOT_SERIALIZE')
    expect(container.innerHTML).not.toContain('staff_role')
    expect(auth.signOutAction).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', '   ', 42])('uses a neutral fallback rather than an email identifier for display_name=%s', (displayName) => {
    const user: SessionUser = {
      ...student,
      user_metadata: { ...student.user_metadata, display_name: displayName },
    }
    render(<SiteHeader user={user} />)
    const props = prepared()
    expect(avatarSlot(props).props).toEqual({ name: 'You', src: null, size: 'sm' })
    const { container } = render(<>{props.profileTrigger}</>)
    expect(container.innerHTML).not.toContain('SYNTHETIC_PRIVATE_EMAIL')
    expect(container.innerHTML).not.toContain(student.id)
    expect(container.innerHTML).not.toContain('SYNTHETIC_PRIVATE_METADATA_DO_NOT_SERIALIZE')
  })

  it('offers exactly the six requested destinations as real unprefetched account links', () => {
    render(<SiteHeader user={student} />)
    render(<>{prepared().profileContent}</>)
    const account = screen.getByRole('navigation', { name: 'Your account' })
    expect(within(account).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/me', '/me/edit', '/connections/followers', '/connections/following', '/connections', '/settings',
    ])
    for (const name of ['Your profile', 'Edit your profile', 'Followers', 'Following', 'Connections', 'Account & settings']) {
      expect(within(account).getByRole('link', { name })).toHaveAttribute('data-prefetch', 'off')
    }
  })

  it.each([
    { count: 0, label: 'Notifications', badge: '' },
    { count: 12, label: 'Notifications, 12 unread', badge: '12' },
    { count: 105, label: 'Notifications, 105 unread', badge: '99+' },
  ])('uses the supplied real total $count independently of the five-preview cap', ({ count, label, badge }) => {
    render(<SiteHeader user={student} unreadNotifications={count} />)
    const props = prepared()
    expect(props.notificationLabel).toBe(label)
    const slot = render(<>{props.notificationTrigger}</>)
    expect(slot.container.textContent).toBe(badge)
    expect(auth.signOutAction).not.toHaveBeenCalled()
    // Reader outcomes have their own tests; this is the presentation boundary.
  })

  it.each([null, -1, Infinity, NaN])('shows an unknown unread count %s without an invented badge', (count) => {
    render(<SiteHeader user={student} unreadNotifications={count} />)
    const props = prepared()
    expect(props.notificationLabel).toBe('Notifications, unread count unavailable')
    const trigger = render(<>{props.notificationTrigger}</>)
    expect(trigger.container.textContent).toBe('')
    render(<>{props.notificationContent}</>)
    expect(screen.getByRole('status')).toHaveTextContent('Unread count could not be loaded.')
    expect(auth.signOutAction).not.toHaveBeenCalled()
  })

  it.each([
    { role: 'admin' as const, label: 'Site administration' },
    { role: 'moderator' as const, label: 'Moderation workspace' },
  ])('creates the $role destination on the server without a client role prop', ({ role, label }) => {
    render(<SiteHeader user={student} staffRole={role} />)
    const props = prepared()
    expect(props).not.toHaveProperty('staffRole')
    expect(props).not.toHaveProperty('user')
    render(<>{props.campusStaffLink}</>)
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', '/admin')
  })

  it.each(['profileContent', 'campusFooter'] as const)('retains the existing real signout action in $0', async (slot) => {
    const user = userEvent.setup()
    render(<SiteHeader user={student} />)
    render(<>{prepared()[slot]}</>)
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    expect(signOut).toHaveAttribute('type', 'submit')
    expect(signOut.closest('form')).not.toBeNull()
    expect(auth.signOutAction).not.toHaveBeenCalled()
    await user.click(signOut)
    await waitFor(() => expect(auth.signOutAction).toHaveBeenCalledTimes(1))
    // Real cookie/session revocation remains the browser/action suite's job.
  })

  it('preserves the bounded native search form without client identity/query props', () => {
    render(<SiteHeader user={student} />)
    const search = screen.getByRole('search', { name: 'Search Bulla' })
    expect(search).toHaveAttribute('action', '/search')
    const input = within(search).getByRole('searchbox', { name: 'Search Bulla' })
    expect(input).toHaveAttribute('name', 'q')
    expect(input).toHaveAttribute('maxlength', '120')
    expect(input).toHaveClass('min-h-11')
    // Class intent is not a computed 44px/reflow assertion in JSDOM.
  })

  it('allows the header row to wrap without shrinking away its controls', () => {
    const { container } = render(<SiteHeader user={student} />)
    const row = container.querySelector('header > div')
    expect(row).not.toBeNull()
    expect(row).toHaveClass('flex-wrap', 'min-w-0')
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('shrink-0')
    // Actual narrow-width/zoom placement is main's real-browser gate.
  })

  it('retains signed-out links without constructing panels or action controls', () => {
    render(<SiteHeader user={null} staffRole="admin" />)
    expect(screen.getByRole('link', { name: 'Bulla home' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: 'Join Bulla' })).toHaveAttribute('href', '/signup')
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(boundary.capture).not.toHaveBeenCalled()
    expect(preview.render).not.toHaveBeenCalled()
    expect(auth.signOutAction).not.toHaveBeenCalled()
  })

  it('preserves the private-local and missing-configuration disclosures', () => {
    deployment.configured = false
    deployment.local = true
    render(<SiteHeader user={null} />)
    expect(screen.getByRole('link', { name: 'Service unavailable' })).toHaveAttribute('href', '/help')
    expect(screen.getByRole('link', { name: 'Local mode: private preview on this computer. View configuration.' }))
      .toHaveAttribute('href', '/setup')
  })
})
