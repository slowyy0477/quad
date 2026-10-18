import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { EndOfList, LoadMore } from '@/components/ui/pagination'
import { ProgressMeter } from '@/components/ui/progress-meter'
import { SkeletonList, SkeletonText } from '@/components/ui/skeleton'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'

export const metadata: Metadata = {
  title: 'Design',
  description: 'The interface system, on one page.',
  robots: { index: false, follow: false },
}

/**
 * /design — the living style guide.
 *
 * Every primitive and the four compositions the product is actually made of, on one page,
 * so a UI change can be judged in a single scroll at any width. Nothing here reads the
 * database: all content is sample, and the page says so at the top rather than letting a
 * reviewer mistake a screenshot of it for evidence the product works.
 *
 * This route is not linked from the navigation and is `noindex`. It is a tool for building,
 * not a page for readers.
 */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-2xs font-medium uppercase tracking-[0.16em] text-ink-faint">{children}</p>
  )
}

function Specimen({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-10 border-t border-rule pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xl">{title}</h2>
        {note ? <p className="max-w-md text-xs text-ink-faint">{note}</p> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

const SAMPLE_POST = {
  author: 'Ayesha Raza',
  handle: 'ayesha_r',
  when: '2 hours ago',
  university: 'COMSATS · Attock',
  body: 'Finished the third problem set for discrete structures. The proof for question four took me two evenings and a false start, which is roughly the ratio I expected.',
  project: 'Timetable for lab groups',
  likes: 12,
  comments: 3,
}

export default function DesignPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-rule pb-5">
        <Label>Interface system</Label>
        <h1 className="mt-3 text-3xl">The interface, on one page</h1>
        <p className="mt-3 max-w-prose text-ink-muted">
          Every primitive and the four compositions the product is made of, so a change can be
          judged in one scroll. The rules behind these decisions are in{' '}
          <code className="rounded-sm bg-paper-sunken px-1 py-0.5 text-sm">docs/plan/DESIGN.md</code>.
        </p>
        <Alert className="mt-5" tone="warning" title="Everything below is sample data">
          None of this is read from a database. The page exists to review type, spacing, colour
          and states — not to demonstrate that anything works.
        </Alert>
      </header>

      <Specimen
        title="Type"
        note="Two families, both system-installed. One text-3xl per page; upper-case labels are a field name, never a sentence."
      >
        <div className="space-y-4">
          <div>
            <Label>Display · text-5xl</Label>
            <p className="mt-1 font-display text-5xl text-ink">Your degree is more than a transcript.</p>
          </div>
          <div>
            <Label>Display · text-3xl — page title</Label>
            <p className="mt-1 font-display text-3xl text-ink">Projects</p>
          </div>
          <div>
            <Label>Display · text-xl — section</Label>
            <p className="mt-1 font-display text-xl text-ink">Looking for collaborators</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Body · text-base, max-w-prose</Label>
              <p className="mt-1 max-w-prose text-base text-ink">
                A goal needs a number to count towards — problems done, chapters read, weeks
                logged. The number is typed; the steps are ticked; neither is inferred from the
                other.
              </p>
            </div>
            <div>
              <Label>Secondary · text-sm</Label>
              <p className="mt-1 text-sm text-ink-muted">
                Skills here are what you say they are, and the interface says so.
              </p>
              <Label>Metadata · text-2xs tabular</Label>
              <p className="mt-1 text-2xs tabular-nums text-ink-faint">12 Feb 2026 · 14:08 · 4 min</p>
            </div>
          </div>
        </div>
      </Specimen>

      <Specimen title="Colour" note="If it is green, it is clickable. Nothing decorative is green.">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['paper / paper-raised / paper-sunken', 'Page, a discrete object, inset areas', 'bg-paper border-rule'],
            ['ink / muted / faint', 'Body, secondary, tertiary text', 'bg-ink'],
            ['accent-600', 'Actions, links, current state', 'bg-accent-600'],
            ['highlight-400', 'Attention without action (unread)', 'bg-highlight-400'],
            ['danger-600', 'Destroys something, or failed', 'bg-danger-600'],
            ['success-600', 'A confirmed outcome', 'bg-success-600'],
          ].map(([name, use, swatch]) => (
            <div key={name} className="border-t border-hairline pt-3">
              <div className={`h-8 w-full rounded-sm border border-hairline ${swatch}`} />
              <dt className="mt-2 font-mono text-xs text-ink">{name}</dt>
              <dd className="mt-0.5 text-xs text-ink-muted">{use}</dd>
            </div>
          ))}
        </dl>
      </Specimen>

      <Specimen title="Buttons" note="One primary per screen. Ghost for rows. Danger behind a dialog.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Create your profile</Button>
          <Button variant="secondary">Sign in</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete project</Button>
          <Button variant="link">Read the guidelines</Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg">
            Large action
          </Button>
          <Button variant="secondary" size="sm">
            Small in a row
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="secondary" block className="sm:block">
            Full width on a phone
          </Button>
        </div>
      </Specimen>

      <Specimen title="Badges and alerts" note="A badge is a short state. An alert is a consequence the reader must read.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Open</Badge>
          <Badge tone="accent">Seeking members</Badge>
          <Badge tone="highlight">Unread</Badge>
          <Badge tone="success">Done</Badge>
          <Badge tone="danger">Hidden</Badge>
          <Badge tone="outline">Internship</Badge>
        </div>
        <div className="mt-5 space-y-3">
          <Alert tone="info" title="Rates are enforced in the database">
            A limit is a row in a ledger, not a counter in a component, so it cannot be reset by
            reloading.
          </Alert>
          <Alert tone="success" title="Saved">
            Your profile is up to date.
          </Alert>
          <Alert tone="warning" title="This link could not be checked">
            The notification is accurate; the thing it points at could not be resolved just now.
          </Alert>
          <Alert tone="danger" title="That is not allowed">
            Only the owner of this project can post an update.
          </Alert>
        </div>
      </Specimen>

      <Specimen title="Form" note="Label above, hint under the label, error under the control. Never placeholder-as-label.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="sample-title" label="Title" required hint="A short name for the project." error={undefined}>
            {(props) => <Input {...props} placeholder="Timetable for lab groups" />}
          </Field>
          <Field
            id="sample-handle"
            label="Handle"
            required
            hint="Letters, numbers and underscores. Cannot be changed later."
            error="That handle is already taken."
          >
            {(props) => <Input {...props} defaultValue="ayesha_r" aria-invalid />}
          </Field>
          <Field id="sample-category" label="Category">
            {(props) => (
              <Select {...props} defaultValue="web">
                <option value="web">Web</option>
                <option value="data">Data</option>
                <option value="hardware">Hardware</option>
              </Select>
            )}
          </Field>
          <Field id="sample-credits" label="Credits" hint="0 to 60, one decimal.">
            {(props) => <Input {...props} type="number" defaultValue="3.0" step="0.5" />}
          </Field>
        </div>
        <div className="mt-5">
          <Field id="sample-pitch" label="The pitch" required hint="At least 20 characters. What it is, and why it is worth building.">
            {(props) => (
              <Textarea {...props} rows={3} defaultValue="A shared timetable for lab groups, so nobody turns up to an empty room." />
            )}
          </Field>
        </div>
      </Specimen>

      <Specimen title="Progress, skeletons, pagination" note="A meter only when both numbers are rows. A skeleton, never a spinner.">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-4">
            <ProgressMeter value={3} total={5} label="Steps" />
            <ProgressMeter value={30} total={30} label="Goal" tone="success" />
            <div>
              <Label>Skeleton</Label>
              <div className="mt-2 space-y-2">
                <SkeletonText lines={2} />
                <SkeletonList rows={2} />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <Label>Pagination</Label>
            <LoadMore href="/design?cursor=sample" />
            <EndOfList label="That is everything." />
            <p className="text-xs text-ink-faint">
              Keyset, not offset: the boundary holds while rows are being written.
            </p>
          </div>
        </div>
      </Specimen>

      <Specimen title="Composition — a post" note="A discrete object, so it gets a surface. Inside it, rules rather than nesting.">
        <Surface className="p-5">
          <div className="flex items-start gap-3">
            <Avatar name={SAMPLE_POST.author} className="size-9" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-display text-base text-ink">{SAMPLE_POST.author}</span>
                <span className="text-xs text-ink-faint">@{SAMPLE_POST.handle}</span>
                <span className="text-2xs text-ink-faint">· {SAMPLE_POST.when}</span>
                <Badge tone="outline" className="ml-auto">
                  {SAMPLE_POST.university}
                </Badge>
              </div>
              <p className="mt-2 max-w-prose text-base text-ink">{SAMPLE_POST.body}</p>
              <div className="mt-3 border-l-2 border-rule pl-3">
                <Label>Attached project</Label>
                <p className="mt-0.5 text-sm text-ink">{SAMPLE_POST.project}</p>
              </div>
              <div className="mt-3 flex items-center gap-4 border-t border-hairline pt-3">
                <Button variant="ghost" size="sm">
                  Like · {SAMPLE_POST.likes}
                </Button>
                <Button variant="ghost" size="sm">
                  Comment · {SAMPLE_POST.comments}
                </Button>
                <Button variant="ghost" size="sm">
                  Save
                </Button>
                <span className="ml-auto text-2xs text-ink-faint">Visible to your university</span>
              </div>
            </div>
          </div>
        </Surface>
      </Specimen>

      <Specimen title="Composition — a profile header" note="Left-aligned. The name is the largest thing; the handle is not.">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name="Abdullah Murtaza" className="size-16" />
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-2xl text-ink">Abdullah Murtaza</h3>
            <p className="mt-0.5 text-sm text-ink-muted">
              @abdullah · BS Software Engineering · Semester 1
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              COMSATS University Islamabad, Attock Campus
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="outline">C++</Badge>
              <Badge tone="outline">Python · learning now</Badge>
              <Badge tone="outline">Godot</Badge>
            </div>
            <p className="mt-3 max-w-prose text-sm text-ink">
              Learning game development from scratch. Currently building a 2D platformer and
              losing to the same boss.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm">
                Connect
              </Button>
              <Button variant="secondary" size="sm">
                Message
              </Button>
              <Button variant="ghost" size="sm">
                Follow
              </Button>
            </div>
          </div>
        </div>
        <p className="mt-3 text-2xs text-ink-faint">
          Levels are self-declared. Quad does not test skills, and nothing here is a verification.
        </p>
      </Specimen>

      <Specimen title="Composition — a list row" note="A list is rows on the page separated by hairlines, not a stack of cards.">
        <ul className="divide-y divide-hairline">
          {[
            ['COMSATS University Islamabad, Attock', 'Islamabad · 1,240 students', 'Claimed'],
            ['University of Engineering and Technology, Taxila', 'Taxila · 890 students', null],
            ['NUST', 'Islamabad · 4,100 students', null],
          ].map(([name, meta, state]) => (
            <li key={name} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{name}</p>
                <p className="text-2xs tabular-nums text-ink-faint">{meta}</p>
              </div>
              {state ? <Badge tone="accent">{state}</Badge> : null}
              <Button variant="secondary" size="sm">
                I study here
              </Button>
            </li>
          ))}
        </ul>
      </Specimen>

      <Specimen title="Empty states" note="An absence names the reason and one way forward. Never 'No results' alone.">
        <div className="space-y-4">
          <EmptyState
            title="No projects in this lens yet"
            action={
              <Button variant="primary" size="sm">
                Create the first project
              </Button>
            }
          >
            Nothing is marked as looking for collaborators right now. If you are building
            something, open it here and say which skills you need.
          </EmptyState>
          <EmptyState title="No notifications yet">
            When someone replies to you, asks to connect, or a moderator decides something about
            your content, it will appear here.
          </EmptyState>
        </div>
      </Specimen>

      <Specimen
        title="Responsive"
        note="Three widths are designed: 360 one column, 768 two, 1280 three with the column still a column."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {['One column', 'Two columns at sm', 'Three at lg'].map((label) => (
            <div
              key={label}
              className="rounded-sm border border-dashed border-rule px-3 py-6 text-center"
            >
              <p className="text-xs text-ink-muted">{label}</p>
            </div>
          ))}
        </div>
        <ul className="mt-5 space-y-2 text-sm text-ink-muted">
          <li className="border-l-2 border-highlight-400 pl-3">
            <span className="text-ink">At 360px</span> the header keeps the wordmark and a menu;
            the bottom bar carries Feed, Projects, Messages and You with 44px targets. Two-pane
            screens become two views.
          </li>
          <li className="border-l-2 border-highlight-400 pl-3">
            <span className="text-ink">At 768px</span> list-and-detail and main-and-side become
            possible; the bottom bar gives way to header navigation.
          </li>
          <li className="border-l-2 border-highlight-400 pl-3">
            <span className="text-ink">At 1280px</span> the extra width goes to margins, not to
            longer lines. Body text stays inside max-w-prose.
          </li>
        </ul>
      </Specimen>

      <Specimen title="Banned" note="Read this against every new screen, in order.">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-muted">
          {[
            'Violet-to-blue gradients — anywhere, including text',
            'Frosted glass panels',
            'Glows or coloured shadows under cards',
            'Every paragraph in its own rounded box',
            '16px radius with a 24px shadow',
            'Emoji as icons',
            'Centred hero + three feature cards + "Get started"',
            'Invented numbers: users, projects, ratings',
            'Exclamation marks and "Oops!"',
            'Equal spacing everywhere, so nothing has hierarchy',
          ].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </Specimen>

      <div className="mt-12 border-t border-rule pt-5">
        <SectionHeading
          title="Where the rules live"
          description="The document is the argument; this page is the evidence."
        />
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            <code className="text-xs">docs/plan/DESIGN.md</code> — colour, type, space, components,
            responsive, copy
          </li>
          <li>
            <code className="text-xs">src/app/globals.css</code> — the tokens themselves
          </li>
          <li>
            <code className="text-xs">src/components/ui</code> — 24 primitives, no more
          </li>
        </ul>
      </div>
    </div>
  )
}
