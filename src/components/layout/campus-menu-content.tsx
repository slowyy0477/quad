import Link from 'next/link'
import type { ReactNode } from 'react'
import { WorkspaceNav } from '@/components/layout/workspace-nav'
import { ThemeToggle } from '@/components/ui/theme-toggle'

/**
 * The existing campus body, used inside HeaderMenus's client graph.
 * The standalone CampusMenu remains unchanged for its other consumers.
 * Staff destinations and signout forms are prepared by the server owner.
 */
export function CampusMenuContent({
  children,
  staffLink,
  onNavigate,
}: {
  children?: ReactNode
  staffLink?: ReactNode
  onNavigate?: () => void
}) {
  return (
    <>
      <WorkspaceNav onNavigate={onNavigate} className="grid grid-cols-2 gap-5 space-y-0" />
      <div className="mt-6 border-t border-hairline pt-4">
        <Link href="/me/edit" onClick={onNavigate}
          className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-paper-sunken">
          Edit your profile
        </Link>
        <Link href="/settings" onClick={onNavigate}
          className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-paper-sunken">
          Account &amp; settings
        </Link>
        {staffLink}
        <p className="mt-3 mb-2 px-3 text-xs font-semibold text-ink-muted">Appearance</p>
        <ThemeToggle className="w-full flex-wrap" />
        {children ? <div className="mt-4 border-t border-hairline pt-3">{children}</div> : null}
      </div>
    </>
  )
}
