import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { ArrowUpRight, GraduationCap } from 'lucide-react'
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
  const monogram = university.short_name?.split(' ')[0]?.slice(0, 4)
  const discoveryHref = `/search?type=people&university=${encodeURIComponent(university.id)}`

  return (
    <li className="university-card interactive-card" data-campus-selected={isMine ? 'true' : undefined}>
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <span className="university-mark" aria-hidden="true">
            {monogram || <GraduationCap className="size-5" />}
          </span>
          <div className="min-w-0">
          <h3 className="text-base text-ink">
            <Link href={discoveryHref} className="underline-offset-4 hover:text-accent-700 hover:underline">
              {university.name}
            </Link>
          </h3>
          {university.short_name ? <p className="mt-1 text-xs text-ink-muted">{university.short_name}</p> : null}
          {isMine ? <p className="mt-1 text-xs font-medium text-accent-700">Your campus</p> : null}
          {university.status === 'pending' ? (
            <Badge tone="highlight">Awaiting review — visible to you only</Badge>
          ) : null}
          {university.status === 'rejected' ? <Badge tone="danger">Not accepted</Badge> : null}
          </div>
        </div>

        {place ? <p className="mt-4 text-sm text-ink-muted">{place}</p> : null}

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

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
        <Link href={discoveryHref}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent-700">
          Find people<ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>
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
