import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Finish your profile' }

export default function Page() {
  return <PlannedFeature title="Finish your profile" featureName="Onboarding (username, university, programme)" />
}
