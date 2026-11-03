import Link from 'next/link'
import { LockKeyhole } from 'lucide-react'

/**
 * A persistent, compact header disclosure. The detail remains one click away;
 * a private preview must never be mistaken for the hosted deployment.
 */
export function LocalModeBanner() {
  return (
    <Link href="/setup"
      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-ink-faint hover:bg-paper-sunken hover:text-ink"
      aria-label="Local mode: private preview on this computer. View configuration."
      title="Private local preview. Accounts and content stay on this computer; no cloud database or email service.">
      <LockKeyhole className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Private preview</span>
    </Link>
  )
}
