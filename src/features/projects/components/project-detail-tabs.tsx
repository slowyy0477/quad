'use client'

import { useRouter } from 'next/navigation'
import { Tabs } from '@/components/ui/tabs'
import { projectDetailHref, type ProjectDetailTab } from '../detail-navigation'

/** The server-selected tab stays authoritative; keyboard selection also updates the URL. */
export function ProjectDetailTabs({
  slug,
  activeTab,
  canManage,
  children,
}: {
  slug: string
  activeTab: ProjectDetailTab
  canManage: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  return (
    <Tabs value={activeTab} onValueChange={(value) => {
      if (value === activeTab) return
      if (value === 'updates' || (canManage && (value === 'requests' || value === 'settings'))) {
        router.push(projectDetailHref(slug, value), { scroll: false })
      }
    }}>
      {children}
    </Tabs>
  )
}
