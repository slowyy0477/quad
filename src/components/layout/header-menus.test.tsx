import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Link from 'next/link'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY } from '@/components/ui/theme-config'
import { HeaderMenus, type HeaderMenusProps } from './header-menus'

const navigation = vi.hoisted(() => ({ pathname: '/feed', follow: vi.fn() }))
const actions = vi.hoisted(() => ({
  read: vi.fn(async (data: FormData) => { void data }),
  signOut: vi.fn(async () => {}),
  outside: vi.fn(),
}))

vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }))
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) => (
    <a {...props} href={href} data-prefetch={prefetch === false ? 'off' : undefined} onClick={(event) => {
      onClick?.(event)
      if (!event.defaultPrevented && event.button === 0 &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        navigation.follow(href)
      }
      // Routing is outside this unit test; retain actual anchor/click semantics.
      event.preventDefault()
    }}>{children}</a>
  ),
}))

function rectangles(values: DOMRect[]): DOMRectList {
  return Object.assign(values, { item: (index: number) => values[index] ?? null })
}

function visibleRectangles(element: HTMLElement): DOMRectList {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    element.matches('input[type="hidden"]')) return rectangles([])
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return rectangles([])
  }
  return rectangles([element.getBoundingClientRect()])
}

beforeEach(() => {
  navigation.pathname = '/feed'
  navigation.follow.mockClear()
  actions.read.mockClear()
  actions.signOut.mockClear()
  actions.outside.mockClear()
  window.localStorage.removeItem(THEME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  document.documentElement.classList.remove('dark')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }))
  // JSDOM has no layout. Rects support visibility/focus interaction only:
  // they are not placement, reflow, 44px hit-area or motion acceptance.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, 0, 320, 44))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return visibleRectangles(this)
  })
})

afterEach(async () => {
  await act(async () => {
    cleanup()
    // Radix's own unmount-focus callback is deferred one turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.removeItem(THEME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  document.documentElement.classList.remove('dark')
})

function slots(read = false): HeaderMenusProps {
  return {
    profileTrigger: <span aria-hidden="true">AS</span>,
    profileContent: (
      <>
        <Link href="/me">Your profile</Link>
        <form action={actions.signOut}><button type="submit">Sign out</button></form>
      </>
    ),
    notificationTrigger: <span aria-hidden="true">Bell</span>,
    notificationLabel: `Notifications, ${read ? 11 : 12} unread`,
    notificationContent: (
      <>
        <p>{read ? 'Read activity.' : 'Unread activity.'}</p>
        {read ? null : (
          <form action={actions.read}>
            <input type="hidden" name="id" value="ntf_headeractivity" />
            <button type="submit">Mark as read</button>
          </form>
        )}
        <Link href="/notifications">View all notifications</Link>
      </>
    ),
    campusStaffLink: <Link href="/admin">Moderation workspace</Link>,
    campusFooter: <form action={actions.signOut}><button type="submit">Sign out</button></form>,
  }
}

function fixture(props = slots()) {
  return (
    <>
      <nav aria-label="Header controls"><HeaderMenus {...props} /></nav>
      <main id="main">
        <button type="button" onClick={actions.outside}>Outside page action</button>
        <Link href="/feed">Outside page link</Link>
      </main>
    </>
  )
}

describe('coordinated nonmodal header panels — boundary unit coverage, not hosted acceptance', () => {
  it.each([
    ['Notifications, 12 unread', 'Notifications'],
    ['Your profile', 'Your profile'],
    ['Open campus menu', 'Campus workspace'],
  ])('%s opens a named panel without navigating or invoking actions', async (label, name) => {
    const user = userEvent.setup()
    render(fixture())
    const trigger = screen.getByRole('button', { name: label })
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).not.toHaveAttribute('href')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(trigger)
    const panel = await screen.findByRole('dialog', { name })
    expect(panel).toHaveAttribute('aria-modal', 'false')
    expect(panel).toHaveAttribute('data-header-menu')
    expect(panel.id).toBe(trigger.getAttribute('aria-controls'))
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Close' })).toHaveFocus())
    expect(navigation.follow).not.toHaveBeenCalled()
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
    await user.click(trigger)
    await waitFor(() => expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument())
  })

  it('keeps only the newly selected panel open across repeated trigger switches', async () => {
    const user = userEvent.setup()
    render(fixture())
    for (const [label, name] of [
      ['Notifications, 12 unread', 'Notifications'],
      ['Your profile', 'Your profile'],
      ['Open campus menu', 'Campus workspace'],
      ['Notifications, 12 unread', 'Notifications'],
    ]) {
      await user.click(screen.getByRole('button', { name: label }))
      const panel = await screen.findByRole('dialog', { name })
      await waitFor(() => expect(within(panel).getByRole('button', { name: 'Close' })).toHaveFocus())
      expect(screen.getAllByRole('dialog')).toEqual([panel])
    }
    expect(navigation.follow).not.toHaveBeenCalled()
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('dismisses with Escape or its unique Close control and restores the trigger', async () => {
    const user = userEvent.setup()
    render(fixture())
    const trigger = screen.getByRole('button', { name: 'Open campus menu' })
    await user.click(trigger)
    await screen.findByRole('dialog', { name: 'Campus workspace' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.click(trigger)
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    await user.click(within(panel).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('allows an outside pointer action on the first click and retains its focus', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Your profile' }))
    await screen.findByRole('dialog', { name: 'Your profile' })
    const outside = screen.getByRole('button', { name: 'Outside page action' })
    expect(outside.closest('[aria-hidden="true"], [inert]')).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
    await user.click(outside)
    expect(actions.outside).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(outside).toHaveFocus())
  })

  it('dismisses on outside focus without pulling focus back into the panel', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Your profile' }))
    await screen.findByRole('dialog', { name: 'Your profile' })
    const outside = screen.getByRole('button', { name: 'Outside page action' })
    act(() => outside.focus())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(outside).toHaveFocus())
    expect(actions.outside).not.toHaveBeenCalled()
  })

  it('keeps ordinary in-panel Tab navigation instead of treating every Tab as dismissal', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Your profile' }))
    const panel = await screen.findByRole('dialog', { name: 'Your profile' })
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Close' })).toHaveFocus())
    await user.tab()
    expect(within(panel).getByRole('link', { name: 'Your profile' })).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Your profile' })).toBe(panel)
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('exits backward from Close to the trigger instead of wrapping to Sign out', async () => {
    const user = userEvent.setup()
    render(fixture())
    const trigger = screen.getByRole('button', { name: 'Open campus menu' })
    await user.click(trigger)
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Close' })).toHaveFocus())
    await user.tab({ shift: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Outside page action' })).toHaveFocus()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'Open campus menu', name: 'Campus workspace', lastRole: 'button', lastName: 'Sign out' },
    { label: 'Your profile', name: 'Your profile', lastRole: 'button', lastName: 'Sign out' },
    { label: 'Notifications, 12 unread', name: 'Notifications', lastRole: 'link', lastName: 'View all notifications' },
  ])('leaves $name forward-edge Tab unconsumed at its inline trigger', async ({ label, name, lastRole, lastName }) => {
    const user = userEvent.setup()
    render(fixture())
    const trigger = screen.getByRole('button', { name: label })
    await user.click(trigger)
    const panel = await screen.findByRole('dialog', { name })
    const last = within(panel).getByRole(lastRole, { name: lastName })
    act(() => last.focus())
    // user-event chooses Tab's default destination from the ORIGINAL key
    // target, not focus moved by a handler. Assert capture/Radix semantics
    // here; this two-event seam is NOT proof of a one-key browser exit.
    const tab = createEvent.keyDown(last, { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })
    fireEvent(last, tab)
    expect(tab.defaultPrevented).toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    await user.tab()
    const expectedNext = name === 'Notifications'
      ? screen.getByRole('button', { name: 'Your profile' })
      : name === 'Your profile'
        ? screen.getByRole('button', { name: 'Open campus menu' })
        : screen.getByRole('button', { name: 'Outside page action' })
    expect(expectedNext).toHaveFocus()
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('dismisses only when an ordinary internal link is activated', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Open campus menu' }))
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    const projects = within(panel).getByRole('link', { name: 'Projects' })
    expect(projects).toHaveAttribute('href', '/projects')
    await user.click(projects)
    expect(navigation.follow).toHaveBeenCalledWith('/projects')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('preserves modified-link behavior without ordinary navigation/dismissal', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Open campus menu' }))
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    await user.keyboard('{Control>}')
    await user.click(within(panel).getByRole('link', { name: 'Projects' }))
    await user.keyboard('{/Control}')
    expect(screen.getByRole('dialog', { name: 'Campus workspace' })).toBe(panel)
    expect(navigation.follow).not.toHaveBeenCalled()
  })

  it('reuses the complete WorkspaceNav route map and server staff/footer slots', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Open campus menu' }))
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    const workspace = within(panel).getByRole('navigation', { name: 'Campus workspace' })
    for (const [name, href] of [
      ['Feed', '/feed'], ['Discover', '/search'], ['Projects', '/projects'],
      ['Messages', '/messages'], ['Learning', '/goals'], ['People', '/feed/people'],
      ['Ideas', '/ideas'], ['Opportunities', '/opportunities'], ['Events', '/events'],
      ['Universities', '/universities'], ['Saved posts', '/saved'],
      ['Connections', '/connections'], ['Study log', '/log'],
    ]) {
      expect(within(workspace).getByRole('link', { name })).toHaveAttribute('href', href)
    }
    expect(within(workspace).getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page')
    expect(within(panel).getByRole('link', { name: 'Moderation workspace' })).toHaveAttribute('href', '/admin')
    expect(within(panel).getByRole('button', { name: 'Sign out' })).toHaveAttribute('type', 'submit')
    expect(within(panel).getByRole('group', { name: 'Theme' })).toBeVisible()
  })

  it('changes the existing theme preference without closing, reading or navigating', async () => {
    const user = userEvent.setup()
    render(fixture())
    await user.click(screen.getByRole('button', { name: 'Open campus menu' }))
    const panel = await screen.findByRole('dialog', { name: 'Campus workspace' })
    const theme = within(panel).getByRole('group', { name: 'Theme' })
    await user.click(within(theme).getByRole('button', { name: 'Dark' }))
    expect(within(theme).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('dialog', { name: 'Campus workspace' })).toBe(panel)
    expect(navigation.follow).not.toHaveBeenCalled()
    expect(actions.read).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it('keeps the notification panel mounted across a read form and same-route slot refresh', async () => {
    const user = userEvent.setup()
    const view = render(fixture())
    await user.click(screen.getByRole('button', { name: 'Notifications, 12 unread' }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(actions.read).not.toHaveBeenCalled()
    await user.click(within(panel).getByRole('button', { name: 'Mark as read' }))
    await waitFor(() => expect(actions.read).toHaveBeenCalledTimes(1))
    expect(actions.read.mock.calls[0]?.[0].get('id')).toBe('ntf_headeractivity')
    // A refusal/no-op leaves the unread slot and must not dismiss the panel.
    view.rerender(fixture(slots(false)))
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBe(panel)
    expect(within(panel).getByRole('button', { name: 'Mark as read' })).toBeVisible()
    // A real accepted server response supplies read state and the true total.
    view.rerender(fixture(slots(true)))
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBe(panel)
    expect(within(panel).getByText('Read activity.')).toBeVisible()
    expect(within(panel).queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Notifications, 11 unread' })).toHaveAttribute('aria-expanded', 'true')
    expect(navigation.follow).not.toHaveBeenCalled()
    expect(actions.signOut).not.toHaveBeenCalled()
  })
})
