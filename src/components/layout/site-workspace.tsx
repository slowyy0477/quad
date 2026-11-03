'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings, CircleHelp } from 'lucide-react'
import { WorkspaceNav } from './workspace-nav'

/** Server-rendered pages remain children; only navigation state runs on the client. */
export function SiteWorkspace({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const pathname = usePathname()
  const focused = ['/', '/login', '/signup', '/onboarding', '/reset-password'].includes(pathname) ||
    pathname.startsWith('/auth/') || pathname.startsWith('/admin')
  if (!signedIn || focused) return <main id="main" tabIndex={-1}>{children}</main>

  return (
    <div className="app-shell">
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <div className="workspace-sidebar-inner">
          <WorkspaceNav compact />
          <div className="mt-7 flex gap-1 border-t border-hairline pt-3">
            <Link href="/settings" className="sidebar-utility"><Settings className="size-4" aria-hidden="true" />Settings</Link>
            <Link href="/help" className="sidebar-utility"><CircleHelp className="size-4" aria-hidden="true" />Help</Link>
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0">{children}</main>
    </div>
  )
}
