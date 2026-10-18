import type { ProfileInterest } from '@/features/skills/queries'

/**
 * Interests, as tags.
 *
 * Labels rather than links: there is no interest page to link to yet, and a tag
 * that looks clickable and is not is the fake control PRODUCT.md forbids. When a
 * topic page exists, these become links and nothing else changes.
 *
 * The self-declared note is not repeated here. It belongs to skill levels, which
 * are the claim that could be mistaken for verification; an interest is a
 * statement of curiosity and claiming it as anything else would be a stretch.
 */
export function InterestTags({
  interests,
  isSelf = false,
}: {
  interests: ProfileInterest[]
  isSelf?: boolean
}) {
  if (interests.length === 0) return null

  return (
    <ul className="flex flex-wrap gap-2">
      {interests.map((interest) => (
        <li
          key={interest.interest_id}
          className="rounded-sm border border-hairline bg-paper-sunken px-2 py-1 text-2xs text-ink-muted"
        >
          {interest.name}
          {isSelf && !interest.is_approved ? (
            <span className="text-ink-faint"> · waiting for review</span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
