import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import {
  DEPARTMENT_QUERY_MAX, PEOPLE_QUERY_MAX, SKILL_QUERY_MAX, type PeopleFilters,
} from '@/features/search/filters'
import type { DiscoveryUniversity } from '@/features/search/people'

/** GET submissions carry every filter and drop the previous page's cursor. */
export function PeopleFilterForm({
  filters, universities, action = '/search', hasMoreUniversities = false,
}: {
  filters: PeopleFilters
  universities: DiscoveryUniversity[]
  action?: '/search' | '/feed/people'
  hasMoreUniversities?: boolean
}) {
  const selectedMissing = filters.universityId &&
    !universities.some((row) => row.id === filters.universityId)
  return (
    <form action={action} method="get" key={JSON.stringify(filters)} className="space-y-4" aria-label="Filter people">
      {action === '/search' ? <input type="hidden" name="type" value="people" /> : null}
      <div>
        <label htmlFor="people-name" className="mb-1 block text-sm font-medium text-ink">Name or username</label>
        <Input id="people-name" name="q" type="search" defaultValue={filters.query}
          maxLength={PEOPLE_QUERY_MAX} placeholder="A name, or leave empty to browse" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="people-university" className="mb-1 block text-sm font-medium text-ink">University</label>
          <Select id="people-university" name="university" defaultValue={filters.universityId ?? ''}>
            <option value="">All universities</option>
            {selectedMissing ? <option value={filters.universityId!}>Selected institution</option> : null}
            {universities.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="people-department" className="mb-1 block text-sm font-medium text-ink">Department contains</label>
          <Input id="people-department" name="department" defaultValue={filters.department}
            maxLength={DEPARTMENT_QUERY_MAX} placeholder="e.g. Computer Science" />
        </div>
        <div>
          <label htmlFor="people-skill" className="mb-1 block text-sm font-medium text-ink">Skill contains</label>
          <Input id="people-skill" name="skill" defaultValue={filters.skill}
            maxLength={SKILL_QUERY_MAX} placeholder="e.g. TypeScript" aria-describedby="people-skill-note" />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Button type="submit" variant="primary">Find people</Button>
          <Link href={action === '/search' ? '/search?type=people' : '/feed/people?university='}
            className="inline-flex min-h-11 items-center text-sm text-accent-700 underline underline-offset-4">
            Clear filters
          </Link>
        </div>
      </div>
      <p id="people-skill-note" className="text-xs text-ink-faint">
        Affiliations and skill levels are self-declared. Department and skill match literal names,
        not biographies, private learning or measured ability.
      </p>
      {hasMoreUniversities ? (
        <p className="text-xs text-ink-faint">
          The picker is a bounded catalogue, not a complete list.{' '}
          <Link href="/universities" className="text-accent-700 underline">Open the institution directory</Link>.
        </p>
      ) : null}
    </form>
  )
}
