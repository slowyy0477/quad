import type { Metadata } from 'next'
import { PlannedFeature } from '@/components/layout/planned-feature'

export const metadata: Metadata = { title: 'Universities' }

export default function Page() {
  return <PlannedFeature title="Universities" featureName="Universities, departments, programmes" />
}
