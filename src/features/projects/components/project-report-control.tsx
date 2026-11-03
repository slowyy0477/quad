'use client'

import { Flag } from 'lucide-react'
import { ReportDialog } from '@/features/moderation/components/report-dialog'

/**
 * Keep the host trigger in the client tree that owns Radix's asChild slot.
 * An opaque server-rendered trigger can disappear during prerendering and
 * reappear during hydration, replacing the project tree and its active tab.
 */
export function ProjectReportControl({ projectId }: { projectId: string }) {
  return (
    <ReportDialog
      kind="project"
      targetId={projectId}
      subject="this project"
      trigger={
        <button
          type="button"
          aria-label="Report this project"
          className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded px-2 text-xs text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <Flag className="size-3.5" aria-hidden="true" />
          Report
        </button>
      }
    />
  )
}
