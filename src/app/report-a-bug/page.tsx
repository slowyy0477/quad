import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Report a bug' }

export default function Page() {
  return <PlannedFeature title="Report a bug" featureName="Bug reporting" />
}
