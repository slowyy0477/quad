import type { Metadata } from 'next'
import { OwnGraphPage } from '@/features/connections/components/graph-page'

export const metadata: Metadata = { title: 'Your connections' }

export default function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <OwnGraphPage direction="connections" searchParams={searchParams} />
}
