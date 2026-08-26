import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Your profile' }

export default function Page() {
  return <PlannedFeature title="Your profile" featureName="Profiles" />
}
