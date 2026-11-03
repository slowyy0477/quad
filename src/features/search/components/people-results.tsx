import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PersonRow } from '@/features/connections/components/person-row'
import type { ProfileSummary } from '@/features/profiles/queries'
import type { DiscoveryPerson } from '@/features/search/people'

export function DiscoveryPersonRow({ person }: { person: ProfileSummary | DiscoveryPerson }) {
  const details = 'skills' in person ? person : null
  return (
    <PersonRow person={person} meta={details ? (
      <div className="space-y-2">
        {details.university || details.department ? (
          <p>{[details.university?.name, details.department].filter(Boolean).join(' · ')}</p>
        ) : null}
        {details.skills.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Self-declared skills">
            {details.skills.map((skill) => (
              <li key={skill.id}>
                <Badge tone="outline">
                  {skill.name} · {skill.level}{skill.is_learning && skill.level !== 'learning' ? ' · learning' : ''}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    ) : undefined}>
      <Link href={`/u/${encodeURIComponent(person.username)}`}
        className="inline-flex min-h-11 items-center text-sm text-accent-700 underline underline-offset-4">
        Open profile
      </Link>
    </PersonRow>
  )
}

export function PeopleResults({ people }: { people: DiscoveryPerson[] }) {
  return (
    <ul className="divide-y divide-hairline">
      {people.map((person) => <DiscoveryPersonRow key={person.id} person={person} />)}
    </ul>
  )
}
