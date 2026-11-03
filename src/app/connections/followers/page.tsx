import type { Metadata } from 'next'
import { OwnGraphPage } from '@/features/connections/components/graph-page'

export const metadata: Metadata = { title: 'Your followers' }

export default function FollowersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <OwnGraphPage direction="followers" searchParams={searchParams} />
}
