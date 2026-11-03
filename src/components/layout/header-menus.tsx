'use client'

import * as Popover from '@radix-ui/react-popover'
import { Menu, X } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { CampusMenuContent } from './campus-menu-content'
import styles from './header-menus.module.css'

type HeaderMenu = 'profile' | 'notifications' | 'campus'

/** Identity, staff destinations and action forms arrive as server-rendered slots. */
export type HeaderMenusProps = {
  profileTrigger: ReactNode
  profileContent: ReactNode
  notificationTrigger: ReactNode
  notificationLabel: string
  notificationContent: ReactNode
  campusStaffLink?: ReactNode
  campusFooter?: ReactNode
}

function tabControls(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, summary, [tabindex]',
  )).filter((element) =>
    element.tabIndex >= 0 && !element.matches(':disabled') &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(element).visibility === 'visible' && element.getClientRects().length > 0,
  )
}

/**
 * Three nonmodal anchored dialogs, one state. No read/signout action is imported
 * here, and opening or a same-route server refresh does not mutate/close a menu.
 */
export function HeaderMenus({
  profileTrigger,
  profileContent,
  notificationTrigger,
  notificationLabel,
  notificationContent,
  campusStaffLink,
  campusFooter,
}: HeaderMenusProps) {
  const [open, setOpen] = useState<HeaderMenu | null>(null)
  const id = useId()
  const triggers = useRef<Partial<Record<HeaderMenu, HTMLButtonElement | null>>>({})
  const skipRestore = useRef<HeaderMenu | null>(null)

  function closeForNavigation(menu: HeaderMenu) {
    skipRestore.current = menu
    setOpen((current) => current === menu ? null : current)
  }

  function navigateFromSlot(event: MouseEvent<HTMLDivElement>, menu: HeaderMenu) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(target instanceof HTMLAnchorElement) || target.hasAttribute('download') ||
      (target.target && target.target !== '_self')) return
    // Only a real link dismisses. Buttons and server read forms remain mounted.
    closeForNavigation(menu)
  }

  function exitOnTab(event: KeyboardEvent<HTMLDivElement>, menu: HeaderMenu) {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    const controls = tabControls(event.currentTarget)
    const edge = event.shiftKey ? controls[0] : controls.at(-1)
    if (!edge || document.activeElement !== edge) return
    const trigger = triggers.current[menu]
    if (!trigger) return

    // Installed Radix Popover 1.1.15 is nonmodal but its FocusScope still loops.
    // Move to the inline trigger BEFORE that bubble handler can wrap the edge.
    // Forward Tab remains native; Shift+Tab returns to the owning trigger.
    // The one-key forward exit still needs native-browser acceptance.
    closeForNavigation(menu)
    trigger.focus({ preventScroll: true })
    if (event.shiftKey) event.preventDefault()
  }

  function panel(
    menu: HeaderMenu,
    title: string,
    description: string,
    label: string,
    trigger: ReactNode,
    content: ReactNode,
  ) {
    const titleId = `${id}-${menu}-title`
    const descriptionId = `${id}-${menu}-description`
    return (
      <Popover.Root key={menu} modal={false} open={open === menu} onOpenChange={(next) => {
        // A late close from the old popover must not close a newly opened one.
        setOpen((current) => next ? menu : current === menu ? null : current)
      }}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={label} className={styles.trigger}
            ref={(node) => { triggers.current[menu] = node }}>
            {trigger}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom" align="end" sideOffset={8} collisionPadding={12} avoidCollisions
            className={styles.panel} data-header-menu={menu} aria-modal={false}
            aria-labelledby={titleId} aria-describedby={descriptionId}
            onClickCapture={(event) => navigateFromSlot(event, menu)}
            onKeyDownCapture={(event) => exitOnTab(event, menu)}
            onCloseAutoFocus={(event) => {
              if (skipRestore.current === menu) {
                event.preventDefault()
                skipRestore.current = null
              }
              // Otherwise Radix restores Escape/Close focus and preserves
              // outside-pointer/focus destinations for this nonmodal popover.
            }}
          >
            <div className={styles.heading}>
              <div className="min-w-0">
                <h2 id={titleId} className="text-base font-semibold">{title}</h2>
                <p id={descriptionId} className="mt-1 text-xs text-ink-muted">{description}</p>
              </div>
              <Popover.Close asChild>
                <button type="button" aria-label="Close" className={styles.close}>
                  <X className="size-4" aria-hidden="true" />
                </button>
              </Popover.Close>
            </div>
            <div className={styles.body}>{content}</div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    )
  }

  return (
    <>
      {panel('notifications', 'Notifications', 'Recent activity addressed to you.',
        notificationLabel, notificationTrigger, notificationContent)}
      {panel('profile', 'Your profile', 'Your profile, relationships and account.',
        'Your profile', profileTrigger, profileContent)}
      {panel('campus', 'Campus workspace', 'Find your next project, keep learning, and stay connected.',
        'Open campus menu', <Menu className="size-5" aria-hidden="true" />,
        <CampusMenuContent staffLink={campusStaffLink}>
          {campusFooter}
        </CampusMenuContent>)}
    </>
  )
}
