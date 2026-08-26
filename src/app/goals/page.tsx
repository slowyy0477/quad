import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Goals and study log' }

export default function Page() {
  return <PlannedFeature title="Goals and study log" featureName="Semester goals and daily study log" />
}
