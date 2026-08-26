import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Opportunities' }

export default function Page() {
  return <PlannedFeature title="Opportunities" featureName="Opportunities and events" />
}
