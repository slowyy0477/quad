import type { Metadata } from 'next'
import { PublicGraphPage } from '@/features/connections/components/graph-page'

export const metadata: Metadata = { title: 'Followers' }

export default async function FollowersPage({
  params, searchParams,
}: {
  params: Promise<{ username: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { username } = await params
  return <PublicGraphPage username={username} direction="followers" searchParams={searchParams} />
}
