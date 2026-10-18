import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import type { SkillOption, UniversityFilterOption } from '@/features/projects/queries'

/**
 * The discovery filters.
 *
 * A plain GET form, on purpose. It works before any JavaScript arrives, the filtered
 * result is a real URL that can be shared or reloaded, and the back button behaves.
 * The alternatives — a controlled select that refetches on change — buy nothing here
 * and cost a client component on a route that otherwise has none.
 *
 * `lens` is carried through as a hidden field so filtering the "open to join" list
 * does not silently drop the reader back into "my projects".
 */
export function ProjectFilters({
  skills,
  universities,
  skill,
  university,
  lens,
}: {
  skills: SkillOption[]
  universities: UniversityFilterOption[]
  skill?: string
  university?: string
  lens: string
}) {
  return (
    <form method="get" action="/projects" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="lens" value={lens} />

      <label className="space-y-1.5 text-sm">
        <span className="block font-medium text-ink">Skill</span>
        <Select name="skill" defaultValue={skill ?? ''} className="min-w-40">
          <option value="">Any skill</option>
          {skills.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="space-y-1.5 text-sm">
        <span className="block font-medium text-ink">University</span>
        <Select name="university" defaultValue={university ?? ''} className="min-w-48">
          <option value="">Any university</option>
          {universities.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      </label>

      <Button type="submit" variant="secondary">
        Apply filters
      </Button>

      {skill || university ? (
        <Button asChild variant="ghost">
          {/* Clearing is a link, not a button: it is navigation to an unfiltered list. */}
          <a href={`/projects?lens=${encodeURIComponent(lens)}`}>Clear</a>
        </Button>
      ) : null}
    </form>
  )
}
