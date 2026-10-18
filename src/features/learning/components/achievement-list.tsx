import { Badge } from '@/components/ui/badge'

/**
 * Achievements, as sentences.
 *
 * There is no locked grid and no "3 of 5" here. Every row was awarded by a trigger over a
 * count it actually took (`app.award_achievement`), so the only honest rendering is the
 * badge you hold together with the rule that earned it — `criteria` is shown verbatim,
 * because a badge whose meaning the holder cannot look up is decoration.
 *
 * Sorted by category on the server, so the order does not depend on which row was written
 * first.
 */
export type AchievementItem = {
  key: string
  name: string
  description: string
  criteria: string
  category: string
  tier: string
  icon: string
  awarded_at: string
  awarded_value: number | null
}

export function AchievementList({
  achievements,
}: {
  achievements: AchievementItem[]
}) {
  if (achievements.length === 0) return null

  return (
    <ul className="divide-y divide-hairline">
      {achievements.map((achievement) => {
        const awarded = new Date(achievement.awarded_at)
        return (
          <li key={achievement.key} className="flex items-start gap-3 py-3">
            <span
              aria-hidden
              className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[3px] border border-rule text-xs text-ink-muted"
            >
              {/* A single character from the definition, not an emoji font: the record is
                  data, and a glyph that depends on the reader's emoji set is not a record. */}
              {achievement.icon.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <p className="text-sm font-medium text-ink">{achievement.name}</p>
                <Badge tone="outline">{achievement.tier}</Badge>
                <span className="text-2xs text-ink-faint">
                  earned{' '}
                  {Number.isNaN(awarded.getTime())
                    ? 'at an unrecorded time'
                    : awarded.toISOString().slice(0, 10)}
                  {achievement.awarded_value !== null ? ` · counted ${achievement.awarded_value}` : ''}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">{achievement.description}</p>
              <p className="mt-1 text-xs text-ink-faint">{achievement.criteria}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
