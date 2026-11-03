export type ProjectDetailTab = 'updates' | 'requests' | 'settings'

/** A URL selects a section, never the permission to read its private contents. */
export function projectDetailTab(
  requested: string | string[] | undefined,
  canManage: boolean,
): ProjectDetailTab {
  const value = Array.isArray(requested) ? requested[0] : requested
  return canManage && (value === 'requests' || value === 'settings') ? value : 'updates'
}

/** Native links work before hydration and do not retain stale creation receipts. */
export function projectDetailHref(slug: string, tab: ProjectDetailTab): string {
  const pathname = `/projects/${encodeURIComponent(slug)}`
  return tab === 'updates' ? pathname : `${pathname}?tab=${tab}`
}
