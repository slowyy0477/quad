import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Search' }

export default function Page() {
  return <PlannedFeature title="Search" featureName="Search" />
}
