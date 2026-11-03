import type { Metadata } from 'next'
import { OwnGraphPage } from '@/features/connections/components/graph-page'

export const metadata: Metadata = { title: 'People you follow' }

export default function FollowingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <OwnGraphPage direction="following" searchParams={searchParams} />
}
