import { Count } from '@/components/ui/stat-row'
import { SKILL_LEVEL_LABELS } from '@/features/skills/schemas'
import type { ProfileSkill } from '@/features/skills/queries'

/**
 * The skills a person claims, as shown on a profile.
 *
 * Three deliberate constraints.
 *
 * 1. **The level is plain text, not a badge, not a bar, not a colour.** PRODUCT.md
 *    says a level here is self-declared and nothing measures it, so anything that
 *    looked like a score — a meter, a coloured pill, a percentage — would be the
 *    interface claiming a verification that does not exist.
 *
 * 2. **The sentence saying so is part of this component**, not of the page that
 *    uses it. It cannot be left out by a caller who forgot, which is the usual way
 *    a disclosure quietly disappears.
 *
 * 3. **Endorsements are a count over rows** (`profile_skills.endorsement_count`,
 *    maintained from `profile_skill_endorsements`), shown only when there is at
 *    least one. It is a fact about other people, not a level, and it is kept
 *    visually quieter than the skill name so it cannot be read as a score.
 */
export function SkillList({
  skills,
  isSelf = false,
}: {
  skills: ProfileSkill[]
  /** Adds the review state of entries the owner proposed, which only they can see. */
  isSelf?: boolean
}) {
  if (skills.length === 0) return null

  return (
    <div>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {skills.map((skill) => (
          <li key={skill.skill_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
            <span className="text-sm text-ink">{skill.name}</span>
            <span className="text-xs text-ink-muted">{SKILL_LEVEL_LABELS[skill.level]}</span>
            {skill.is_learning ? <span className="text-xs text-ink-faint">learning now</span> : null}
            {skill.endorsement_count > 0 ? (
              <Count
                value={skill.endorsement_count}
                singular="endorsement"
                className="text-xs text-ink-faint"
              />
            ) : null}
            {isSelf && !skill.is_approved ? (
              <span className="text-xs text-ink-faint">
                waiting for review — only you can see this one
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-ink-faint">
        Levels are self-declared. Quad does not test skills, and nothing on this page is a
        verification.
      </p>
    </div>
  )
}
