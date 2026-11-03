'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Menu } from 'lucide-react'
import { WorkspaceNav } from '@/components/layout/workspace-nav'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { ThemeToggle } from '@/components/ui/theme-toggle'

/** Radix supplies focus trapping, Escape, outside-click and trigger-focus restoration. */
export function CampusMenu({ children, staffRole = null }: { children?: React.ReactNode; staffRole?: 'admin' | 'moderator' | null }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open campus menu">
          <Menu aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent title="Campus workspace" description="Find your next project, keep learning, and stay connected." className="sm:max-w-md">
        <WorkspaceNav onNavigate={() => setOpen(false)} className="grid grid-cols-2 gap-5 space-y-0" />
        <div className="mt-6 border-t border-hairline pt-4">
          <Link href="/me/edit" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-paper-sunken">Edit your profile</Link>
          <Link href="/settings" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-paper-sunken">Account & settings</Link>
          {staffRole ? <Link href="/admin" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-accent-700 hover:bg-accent-50">{staffRole === 'admin' ? 'Site administration' : 'Moderation workspace'}</Link> : null}
          <p className="mt-3 mb-2 px-3 text-xs font-semibold text-ink-muted">Appearance</p>
          <ThemeToggle className="w-full" />
          {children ? <div className="mt-4 border-t border-hairline pt-3">{children}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
