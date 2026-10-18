import type { NotificationDay } from '@/features/notifications/types'
import { NotificationRow } from '@/features/notifications/components/notification-row'

/**
 * The list: day headings with the notifications that fall under each.
 *
 * A heading is a ruled label rather than a card header — the whole page is already one
 * column, and boxing each day would produce the stack-of-panels look the design language
 * exists to avoid. `aria-labelledby` ties each list to its heading so a screen reader
 * announces "Yesterday, list, 4 items" instead of an undifferentiated run of rows.
 */
export function NotificationList({
  days,
  linksResolved,
}: {
  days: NotificationDay[]
  linksResolved: boolean
}) {
  return (
    <div className="space-y-7">
      {days.map((day) => {
        const headingId = `notifications-day-${day.key}`
        return (
          <section key={day.key} aria-labelledby={headingId}>
            <h2
              id={headingId}
              className="border-b border-rule pb-2 text-2xs font-medium uppercase tracking-[0.16em] text-ink-faint"
            >
              {day.label}
            </h2>
            <ul className="divide-y divide-hairline">
              {day.items.map((view) => (
                <NotificationRow key={view.id} view={view} linksResolved={linksResolved} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
