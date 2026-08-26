import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Messages' }

export default function Page() {
  return <PlannedFeature title="Messages" featureName="Direct and group conversations" />
}
