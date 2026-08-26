import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Events' }

export default function Page() {
  return <PlannedFeature title="Events" featureName="Opportunities and events" />
}
