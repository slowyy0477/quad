import type { Metadata } from 'next'
import { PublicGraphPage } from '@/features/connections/components/graph-page'

export const metadata: Metadata = { title: 'Following' }

export default async function FollowingPage({
  params, searchParams,
}: {
  params: Promise<{ username: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { username } = await params
  return <PublicGraphPage username={username} direction="following" searchParams={searchParams} />
}
