import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Projects' }

export default function Page() {
  return <PlannedFeature title="Projects" featureName="Projects, collaborators and applications" />
}
