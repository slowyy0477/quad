import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Ideas' }

export default function Page() {
  return <PlannedFeature title="Ideas" featureName="Ideas and idea-to-project conversion" />
}
