import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Notifications' }

export default function Page() {
  return <PlannedFeature title="Notifications" featureName="Notifications" />
}
