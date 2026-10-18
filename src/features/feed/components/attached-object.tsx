import { Flag, GraduationCap } from 'lucide-react'
import type { AttachedGoal, AttachedProject } from '@/features/feed/queries'

/**
 * The object a post is attached to, as a rule-bounded block.
 *
 * This is the part of a Quad post that stops the feed being a decontextualised
 * timeline: PRODUCT.md's claim is that a post is *about* something, and this block
 * is where that claim is visible. It is deliberately not a card: the design
 * language says objects are separated with rules and only things that genuinely
 * leave the page get elevation, so the block is a left rule and a label.
 *
 * There is no link on the title yet, and that is a decision rather than an
 * oversight: `/project/[slug]` is M4 and does not exist, and an anchor to a route
 * that 404s is a worse affordance than plain text. The title is the project's own
 * stored title, never a summary invented here.
 */
export function AttachedObject({
  project,
  goal,
}: {
  project: AttachedProject | null
  goal: AttachedGoal | null
}) {
  if (!project && !goal) return null

  if (project) {
    return (
      <div className="mt-3 border-l-2 border-accent-600 pl-3">
        <p className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
          <Flag className="size-3" aria-hidden="true" />
          Project update
        </p>
        <p className="mt-0.5 text-sm font-medium text-ink">{project.title}</p>
        {project.tagline ? (
          <p className="text-xs text-ink-muted">{project.tagline}</p>
        ) : null}
      </div>
    )
  }

  if (!goal) return null

  return (
    <div className="mt-3 border-l-2 border-highlight-400 pl-3">
      <p className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
        <GraduationCap className="size-3" aria-hidden="true" />
        Goal
      </p>
      <p className="mt-0.5 text-sm font-medium text-ink">{goal.title}</p>
      {/* The percentage is a stored column, and it is rendered only when it exists:
          a goal with no progress recorded shows nothing rather than a zero that
          would look like a measurement. */}
      {goal.progress_percent !== null ? (
        <p className="text-xs text-ink-muted tabular">
          {goal.progress_percent}% complete · {goal.status}
        </p>
      ) : (
        <p className="text-xs text-ink-muted">{goal.status}</p>
      )}
    </div>
  )
}
