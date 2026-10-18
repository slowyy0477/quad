# Quad — the interface, decided

This is the document the screens are measured against. It exists because "make it not look
AI-generated" is not a brief: it is a complaint about a set of specific habits, and habits
can be named, banned and checked.

The short version: **this is an editorial interface, not a product dashboard.** It is built
from the vocabulary of a university press — paper, ink, a rule between things, a serif for
display, one institutional colour used only where something is actionable — rather than
from the vocabulary of SaaS (cards, gradients, glows, three-column feature grids).

---

## 1. What makes an interface look generated

Ten habits, in the order they give a design away. Each one is banned here, and the ban is
the reason the rest of this document exists.

| # | The tell | What we do instead |
|---|---|---|
| 1 | Violet-to-blue gradient on anything | One flat institutional green (`accent-600`) for actions. No gradients anywhere, including text. |
| 2 | Frosted glass, `backdrop-blur` on panels | Paper and rules. The header may blur 2px because it scrolls over text; nothing else does. |
| 3 | A glow or coloured shadow under a card | Rules. A 1px line separates; a shadow means something floats (menus, dialogs only). |
| 4 | Every paragraph in its own rounded box | Content sits on the page. A `Surface` is for a discrete object, never for a section of prose. |
| 5 | Cards with 16px radius and a 24px shadow | 4px radius, `border-hairline`, no shadow. Radius is enough to look intentional, not enough to look like a pill. |
| 6 | Emoji as icons, or an icon on every line | Icons only where they carry meaning; drawn as SVG strokes, never emoji. Labels are words. |
| 7 | Centred hero + three feature cards + "Get started" | A left-aligned editorial column with a real argument in it, and one call to action. |
| 8 | Fake numbers, fake avatars, "10,000+ users" | Every number is a query over stored rows, or it is not printed. Sample data is labelled as sample data. |
| 9 | Purple-on-white "friendly" copy with exclamation marks | Plain declarative sentences. No exclamation marks. No "Oops!". No "Let's get you set up!". |
| 10 | Equal spacing everywhere, so nothing has hierarchy | A vertical rhythm with real jumps: 4/8/12/16/24/32/48/64, and section breaks use a rule plus a bigger gap. |

---

## 2. Colour

Defined in `src/app/globals.css` as `@theme` tokens. In oklch so lightness is comparable
across hues.

| Role | Token | Used for | Never used for |
|---|---|---|---|
| Paper | `paper` `paper-raised` `paper-sunken` | Page, a discrete object on the page, inset areas (code, skeletons) | decoration |
| Ink | `ink` `ink-muted` `ink-faint` | Body, secondary, tertiary text | large fills |
| Rule | `rule` `hairline` | Between sections (`rule`), inside a component (`hairline`) | borders on interactive things |
| Accent | `accent-600/700` | Actions, links, current state, a filled primary button | headings, decoration, "brand" washes |
| Highlight | `highlight-400` | Attention without action: unread marks, annotations | buttons |
| Danger | `danger-600/700` | Destructive actions, errors | validation of an untouched field |
| Success | `success-600` | A confirmed outcome | "positive" decoration |

**The accent rule.** If it is green, it is clickable. Nothing decorative is ever green. That
is why the landing page has no green headings and why an unread dot is ochre, not green:
an unread notification is not an action.

Dark mode is an inversion, authored rather than filtered: paper becomes a warm near-black,
the accent lightens to hold contrast, and rules brighten because a hairline that reads on
paper disappears on ink.

---

## 3. Type

Two families, both system-installed, so the page paints without a webfont round trip:

- **Display**: Iowan Old Style → Palatino → Book Antiqua → serif. Headings, names, numbers
  that matter, empty-state titles.
- **Text**: system UI sans. Body, labels, controls, tables.
- **Mono**: only for references and code.

Scale (from `globals.css`, line heights included):

| Token | Size | Used for |
|---|---|---|
| `text-5xl` | 3.6rem | Landing hero only |
| `text-4xl` | 2.9rem | The one number on a page (streak) |
| `text-3xl` | 2.25rem | Page title |
| `text-2xl` | 1.75rem | Section title, dialog title |
| `text-xl` | 1.375rem | Sub-section, card title |
| `text-lg` | 1.125rem | Lead paragraph, row title |
| `text-base` | 1rem | Body |
| `text-sm` | 0.875rem | Secondary body, dense lists |
| `text-xs` | 0.775rem | Metadata, controls at small size |
| `text-2xs` | 0.6875rem | Upper-case labels only |

Rules:

- **One `text-3xl` per page.** A second one means two pages on one screen.
- **Upper-case labels** are `text-2xs`, `tracking-[0.14em]`–`[0.16em]`, `text-ink-faint`, and
  are never a sentence — they are a field name for a section below.
- **Numbers that get compared are tabular** (`tabular-nums`): counts, dates, scores, times.
- **Measure**: body text is `max-w-prose`. A full-width paragraph on a 1280px screen is
  unreadable and is the single most common generated-layout failure after the gradient.

---

## 4. Space, rules, elevation

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64. Nothing between.
- Page container: `max-w-3xl` for an editorial page, `max-w-2xl` for a single column of
  records, `max-w-6xl` for the landing page and multi-column lists.
- Page padding: `px-4 py-8` at 360px, `sm:px-6 sm:py-12` above.
- **Sections are separated by `border-t border-rule` plus `mt-10`.** Not by a card.
- **Inside a list, rows are separated by `divide-y divide-hairline`.** A row's own padding
  is `py-3` to `py-5`, never a margin.
- Two elevations exist: the header (`shadow-none`, a bottom rule) and floating things
  (dropdown, dialog, toast) which get `shadow-md` and nothing else ever does.

---

## 5. Components — what each one is for

The kit is in `src/components/ui`. It is deliberately small: 24 primitives.

| Component | Use it for | Do not use it for |
|---|---|---|
| `Button` primary | The one action a screen exists for | a second action on the same screen |
| `Button` secondary | A real alternative, bordered | navigation |
| `Button` ghost | Toolbar and inline row actions | anything destructive |
| `Button` danger | Destroying something, behind a `Dialog` | validation |
| `Field` | Every form control: wires label, hint, error, `aria-describedby`, `aria-invalid` | a bare `<input>` |
| `Surface` | A discrete object: a post, a project, a form panel | a section of prose |
| `SectionHeading` | Title + rule + optional action for a section | the page title (that is an `h1` in a header) |
| `EmptyState` | A real absence, naming the reason and one way forward | "no results" with no query echoed |
| `Alert` | A consequence the reader must read (error, warning, the CSP note) | success confirmations (use `toast`) |
| `Skeleton*` | The shape of what is arriving | a spinner |
| `ProgressMeter` | completed / total, both from rows | completeness scores |
| `Badge` | A short state (`active`, `pending`, `Done`) | a sentence |
| `Avatar` | A person, with initials when there is no image | a logo |
| `Tabs` | URL-addressable views of the same collection | primary navigation |
| `Dialog` | A decision that needs the context behind it | a form longer than a screen |
| `DropdownMenu` | Per-row secondary actions | primary actions |
| `toast` | Confirmations only | errors |

**The form rule.** Labels above, hints below the label, errors below the control, never
placeholder-as-label. Every control is reachable by keyboard, focus is always visible
(`focus-visible:ring-2 ring-accent-600/40`), and an error is announced (`role="alert"`).

---

## 6. Responsive

Three widths are designed, not merely tolerated. Breakpoints are Tailwind's defaults:
`sm` 640, `md` 768, `lg` 1024.

**360px — the phone.**
- One column. Page padding 16px.
- The header collapses to the wordmark plus a menu; **the bottom bar carries the four
  primary destinations** (Feed, Projects, Messages, You) with 44px targets. Navigation must
  never depend on a hover.
- Two-pane screens become two views: `/messages` shows the list, then the thread with a back
  control. The thread's composer is pinned above the bottom bar, never behind it.
- Tables become definition lists. Nothing scrolls horizontally except a deliberate code
  block.
- Primary actions are full width where they are the point of the screen.

**768px — the tablet.**
- Two columns become available (list + detail, main + side).
- The bottom bar gives way to the header navigation.

**1280px — the desk.**
- The editorial column stays a column: `max-w-3xl` centred inside `max-w-6xl`. The extra
  width goes to margins, not to longer lines.
- Multi-column lists (universities, opportunities) use three columns of rows, each still
  reading top-to-bottom.

**Rules that apply at every width:** no horizontal scroll; nothing important revealed only on
hover; text resizes to 200% without overlap; the layout is usable at 320px.

---

## 7. Copy

- Plain, declarative, no exclamation marks, no "Oops", no "Let's".
- A limit states the number and the reason: "At least 20 characters. What it is, and why it
  is worth building."
- An absence names the reason and one next step.
- A refusal is a sentence from the server: "Only the owner of this project can post an
  update." Never a silent no-op.
- Claims are exact. "52 tables and every one of them has policies" — not "bank-grade
  security". "No adverts in private messages, ever" — a promise specific enough to be broken
  and therefore worth making.

---

## 8. How this gets checked

1. `npm run lint` and `npm run typecheck` on every change.
2. The `/design` route renders every primitive and the four page compositions with sample
   data, at 360 / 768 / 1280, so a regression is visible in one scroll.
3. Screenshots at those three widths are taken before a UI change is called done.
4. The banned list in §1 is read against every new screen, in order.
