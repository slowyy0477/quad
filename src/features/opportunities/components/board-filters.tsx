import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import {
  DEADLINE_WINDOWS,
  OPPORTUNITY_TYPES,
  WORK_MODES,
  opportunityTypeLabel,
  workModeLabel,
} from '@/features/opportunities/constants'

/**
 * The board filters.
 *
 * A plain GET form, for the three reasons the project filters give: it works before any
 * JavaScript arrives, the filtered board is a real URL that can be shared, and the back
 * button behaves. It also clears `cursor` for free -- a form does not post the cursor, so
 * a new filter starts at page one rather than page two of a different result set.
 *
 * The deadline window is only offered on the open lens. "Closes within 30 days" is a
 * statement an open listing can satisfy and a closed one cannot, so offering it beside
 * closed listings would be a control that can only empty the page.
 */
export function BoardFilters({
  lens,
  type,
  workMode,
  within,
}: {
  lens: string
  type?: string
  workMode?: string
  within?: string
}) {
  const isOpen = lens !== 'closed'
  const filtered = Boolean(type || workMode || within)

  return (
    <form method="get" action="/opportunities" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="lens" value={lens} />

      <Field id="filter-type" label="Type" className="w-48">
        {(props) => (
          <Select {...props} name="type" defaultValue={type ?? ''}>
            <option value="">Any type</option>
            {OPPORTUNITY_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field id="filter-mode" label="Where" className="w-40">
        {(props) => (
          <Select {...props} name="mode" defaultValue={workMode ?? ''}>
            <option value="">Anywhere</option>
            {WORK_MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {isOpen ? (
        <Field id="filter-window" label="Closes within" className="w-44">
          {(props) => (
            <Select {...props} name="within" defaultValue={within ?? ''}>
              <option value="">Any date</option>
              {DEADLINE_WINDOWS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      <Button type="submit" variant="secondary">
        Apply filters
      </Button>

      {filtered ? (
        <Button asChild variant="ghost">
          {/* Clearing is a link, not a button: it is navigation to an unfiltered board. */}
          <a href={isOpen ? '/opportunities' : '/opportunities?lens=closed'}>Clear</a>
        </Button>
      ) : null}

      {type || workMode ? (
        <p className="w-full text-xs text-ink-muted" role="status">
          Showing {type ? opportunityTypeLabel(type) : 'any type'}
          {workMode ? ` · ${workModeLabel(workMode)}` : ''}
          {isOpen && within ? ` · closing within ${within} days` : ''}.
        </p>
      ) : null}
    </form>
  )
}
