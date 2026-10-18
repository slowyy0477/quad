import { Badge } from '@/components/ui/badge'
import { Count } from '@/components/ui/stat-row'
import { ClaimUniversityControl } from '@/features/universities/components/claim-university-control'
import type { UniversityListItem } from '@/features/universities/queries'

/**
 * One institution in the directory.
 *
 * The student count is the stored counter from `universities.student_count`, not
 * an estimate and not a rounded "1.2k": it is the same number the trigger
 * maintains and the same one the students themselves are counted in. A count of
 * zero is rendered as zero rather than hidden, because "nobody is here yet" is
 * information a first reader needs.
 */
export function UniversityRow({
  university,
  isMine,
  signedIn,
}: {
  university: UniversityListItem
  isMine: boolean
  signedIn: boolean
}) {
  const place = [university.city, university.country].filter(Boolean).join(', ')

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-base text-ink">{university.name}</h3>
          {university.short_name ? <Badge tone="outline">{university.short_name}</Badge> : null}
          {university.status === 'pending' ? (
            <Badge tone="highlight">Awaiting review — visible to you only</Badge>
          ) : null}
          {university.status === 'rejected' ? <Badge tone="danger">Not accepted</Badge> : null}
        </div>

        {place ? <p className="mt-0.5 text-sm text-ink-muted">{place}</p> : null}

        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          {/* Both numbers are stored counters. Neither is computed for the page. */}
          <Count value={university.student_count} singular="student" />
          <Count value={university.project_count} singular="project" />
          {university.website ? (
            <a
              href={university.website}
              rel="noopener noreferrer"
              target="_blank"
              className="text-accent-700 underline underline-offset-2"
            >
              {university.website.replace(/^https?:\/\//, '')}
            </a>
          ) : null}
        </p>
      </div>

      <div className="shrink-0">
        <ClaimUniversityControl
          universityId={university.id}
          universityName={university.name}
          isMine={isMine}
          signedIn={signedIn}
        />
      </div>
    </li>
  )
}
