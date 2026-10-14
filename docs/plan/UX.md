# UI/UX plan

**This document is the design authority for the build-out.** `globals.css` sets the visual
language and it is good — keep it. This is about the interface layer that has not been built
yet: what components have to exist, what each screen does, what it shows when it has nothing
to show, and how we know it is accessible.

Read alongside [PLAN.md](PLAN.md) (what order) and [ENGINEERING.md](ENGINEERING.md) (what counts
as done).

---

## 1. The visual language is already decided — hold it

`globals.css` documents its own reasoning and the reasoning is sound: an editorial language
built from print rather than from a UI kit, warm paper instead of pure white, one accent used
only for things you can click, **rules instead of shadows**, a 4 px radius, a serif display
face, a real type scale with per-size line heights, class-based dark mode, a single
`:focus-visible` style, reduced-motion honoured, and a skip link.

Two rules follow from it and are easy to break by accident:

1. **Nothing new gets a shadow.** Elevation is `raised` and `float`, both for things that
   genuinely leave the page (menus, dialogs). A card gets a hairline.
2. **Nothing new gets a colour outside the tokens.** The palette is `oklch` so lightness means
   the same thing across hues; a hard-coded hex breaks that and the dark mode with it.

If a screen looks like it needs a third elevation or a new hue, that is a design problem to
solve with layout and rules, not with a new token. Adding tokens is a decision to write down
in `globals.css` next to the reasoning that is already there.

---

## 2. UX findings (measured, not general advice)

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| U1 | **On a phone, a signed-in user has no navigation.** Feed / Projects / Messages are `hidden sm:inline-flex`; there is no bottom nav or sheet. The only reachable control is the avatar → `/me`. | [`site-header.tsx:46-54`](../../src/components/layout/site-header.tsx) | Campus users are mobile-first. This is the most severe UX defect in the project. |
| U2 | **Dark mode cannot be turned on.** `globals.css` says "the settings page offers an explicit choice" and defines `.dark`; there is no `/settings` route and nothing ever sets the class. | no `settings` route in `src/app`; 0 references to `classList.add('dark')` | A documented feature that does not exist — PRODUCT.md rule 2. |
| U3 | **No loading state anywhere.** 0 `loading.tsx` files, no `Skeleton`, no `EmptyState` component, against ARCHITECTURE §9 "a route with no empty state is not done". | `find src/app -name loading.tsx` → 0 | On campus wifi every route shows a blank page; a first-time user cannot tell loading from broken. |
| U4 | **The UI kit is 9 of ~22 primitives**, and 13 Radix packages are installed but never imported. | `grep -rho '@radix-ui/react-[a-z-]*' src` → 2 packages | Every feature milestone re-invents a dialog, a menu or a select, badly, under time pressure. |
| U5 | **The feed's like and comment counts are static text** — correct per the honesty rules, but there is no affordance at all, so the affordance gap is invisible to the user. | `post-card.tsx` | Fine at 3 users, hostile at 50. Becomes controls in M3, deliberately. |
| U6 | **The composer has no character budget, no draft retention, no autosize.** | `post-composer.tsx` | A long post on a phone is unpleasant; a failed submit loses the text. |

---

## 3. UI kit completion contract

One pass, in M2, instead of five improvisations. Every component below: keyboard reachable,
`:focus-visible` respected, `aria-*` correct, dark mode correct, 360 px correct, and rendered
as a **sibling** to the existing primitives so `components/ui/**` still imports nothing from
`features/**`.

| Component | Built on | Required states / behaviour |
| --- | --- | --- |
| `Skeleton` | plain | size prop; respects reduced motion; used by every `loading.tsx` |
| `EmptyState` | `Surface` | title, one-line explanation, optional single action; takes the exact copy from §8 |
| `Dialog` | `@radix-ui/react-dialog` | focus trap, `Esc`, labelled title, scroll lock, mobile = full-screen sheet under `sm` |
| `DropdownMenu` | `@radix-ui/react-dropdown-menu` | used for post actions and the account menu; never the only path to a destructive action |
| `Select` | `@radix-ui/react-select` | university, programme, semester; searchable above ~15 options |
| `Tabs` | `@radix-ui/react-tabs` | profile sections, project tabs; URL-addressable so a tab can be linked |
| `Tooltip` | `@radix-ui/react-tooltip` | icon-only buttons only; never the sole label |
| `Switch`, `Checkbox`, `RadioGroup` | Radix | settings and privacy; label is part of the control, not a sibling `<div>` |
| `ScrollArea` | `@radix-ui/react-scroll-area` | long menus and lists; never a hidden scrollbar for the main page |
| `Separator` | `@radix-ui/react-separator` | the editorial rule, as a component |
| `Toast` | `sonner` (installed, unused) | confirmations only ("Post published"), never for errors that belong inline |
| `MobileNav` | new | bottom bar under `sm`: Feed · Projects · Notifications · Me (U1) |
| `Pagination` / `LoadMore` | new | cursor-based; keeps scroll position; shows a real end state |
| `Textarea` + autosize | new | char counter at the limit, not before; draft kept in `sessionStorage` (U6) |
| `SearchInput` | `Input` | debounced, `type="search"`, `/` focuses it |
| `PersonRow`, `ProjectRow` | `Avatar`, `Badge` | list density variants of the existing cards |
| `StatRow` | new | one number + label, `.tabular`; **only ever fed a stored value** |
| `ProgressMeter` | new | goal and application progress; the value must be derivable from rows, or the meter does not render |
| `ThemeToggle` | new | writes the `dark` class and persists the choice (U2) |

---

## 4. Screens, by milestone

Each screen below is specified as: purpose → layout at 360/768/1280 → the four states →
the one action it exists for. "Empty copy" values are in §8.

### M2 — Identity and people

**`/onboarding`** (exists, verify) — three steps in one page, progressive: username →
university → programme and semester. Sets the real handle that the database already enforces.
Empty: n/a. Error: field-level. Action: "Finish setting up".
Spec: 360 — one column, labels above inputs, sticky submit; 768+ — same, capped at `42rem`.

**`/u/[username]`** public profile (exists, verify) — capabilities before biography:
name, university, programme, semester, then skills with the self-declared label, then
projects, then activity. Non-user visitors get the same page minus private rows.
Empty: "No projects yet" / "No activity yet" as separate empties, not one blank column.
Action: "Connect" (or "Message" once connected).

**`/me/edit`** (exists, verify) — one page, sections as fieldsets, one save at the bottom,
sticky save on mobile. Errors inline, never a toast.

**`/universities`** — browse and search the **53 real institutions** in migration 0017.
Row: name, city, student count (a stored counter). Action: "I study here" → sets the profile
and is reversible. Unknown institution → "Request this university" filing a `pending` row for
a moderator (the path the migration header already describes).

**`/settings`** (new, U2) — appearance (light/dark/system), privacy (who can see what),
account (email, password change, delete with typed confirmation). This also gives U2's
documented feature an address.

### M3 — Feed

**`/feed`** — the work feed. Left-aligned single column, max `42rem`, never centred with a
sidebar that out-weights it. Composer on top; tabs "For you / Following"; cursor "Load more".
Post card: author, time, body (with real line breaks), the object it is attached to (project,
goal) as a rule-bounded block, then actions: like, comment, save, share-copy-link, report.
Like/comment counts become **controls driven by stored counters**, which is the only
honest way they can become interactive.
Empty (new account): "Your feed is empty because you have not connected with anyone. Find
people from your university →". Empty (no posts following): "Nothing here yet. Projects you
join will post updates here."

**Post detail** `/post/[id]` — permalink, full thread, same actions. This is what a shared
link opens, so it must render for a signed-out visitor when the post is public.

**`/search`** (M6 but the input exists from M3) — one field, tabbed results: People, Projects,
Posts, Opportunities. Empty: the query echoed back plus the three suggestions in §8.

### M4 — Projects

**`/projects`** — two lenses, "My projects" and "Open to join", as tabs. A project row:
title, one-line purpose, member avatars, seeking-members badge with the slots required.
Filter by skill and by university. Action: "Create project" or "Join".

**`/projects/[slug]`** — the differentiated page, and the one to make genuinely good:
purpose, timeline, member list with roles, required skills with slots filled, updates stream,
"ask to join" with an optional note. Public and indexable; the public variant hides member
emails and private updates.

**`/ideas`** — idea vault. Idea card: title, pitch, the interests that would make it real.
Action: "Convert to project", which already exists as a database function — the interface must
say what carries across ("3 people interested will be invited").

### M5 — Messaging and notifications

**`/messages`** — 768+: conversation list (20rem) + thread. 360: list, then thread as its own
view with a back control. Thread: day separators, unread divider, composer pinned to the
bottom, realtime with a "reconnecting" indicator that is honest about its state.
Empty: "No conversations yet. Message someone from their profile."

**`/notifications`** — grouped by day, unread marked with the highlight token, "mark all read".
Bell in the header with an unread dot fed by a real count. Empty: "Nothing yet. You will hear
when someone wants to join your project."

### M6 — Learning, opportunities, events, search

**`/goals`, `/log`** — semester goals as a list with a progress meter over real rows; the daily
log as an entry per day with the streak shown as a number and as the last 14 days as marks.
Empty: "No goals for this semester yet."

**`/opportunities`** — intern type filters (internship, scholarship, competition), deadline
sorted, "applied" state remembered per user, deadline passed = visually closed, never hidden.
**`/events`** — list and one event page with attendee count and RSVP.

### M7 — Safety surfaces

**Report dialog** (from any post, comment, profile, message): reason from a fixed list, optional
detail, "we will tell you when a moderator looks at it".
**`/admin`** — moderator queue (reports, pending universities), action with a reason, audit log
view. Every action requires a reason string; no reason, no action.
**`/report-a-bug`** — form, stored, listed for the maintainer.

---

## 5. Interaction rules

1. **Optimistic UI is allowed for exactly three things** — like, save, RSVP — and each must
   reconcile against the server response. Nothing else pretends before it is true.
2. **Never invent a progress state.** No spinner that resolves to nothing; no "1,204 students"
   that is not a `count(*)` over rows.
3. **Destructive actions** are dialogs with the object's name in the title, the confirmation
   button labelled with the verb ("Delete project"), and the safe action focused first.
4. **Errors live next to what caused them.** A field error under the field; a form error at the
   top of the form; a page error as an error boundary that shows `error.digest` only.
5. **Pagination is cursor-based everywhere** that grows without bound, keyboard-reachable, and
   ends with a real "no more" state rather than an infinite spinner.
6. **Motion**: only opacity and transform; 150–200 ms; `--ease-out-soft`; nothing that moves
   more than 24 px; everything inside the reduced-motion query.
7. **Nothing auto-plays, auto-expands or auto-focuses** on load except the composer's field on
   the composer route when the user explicitly opened it.

---

## 6. Accessibility budget

Target **WCAG 2.2 AA**, verified, not asserted.

- Automated: `@axe-core/playwright` in the e2e suite, failing on serious/critical, over the
  ten highest-traffic routes. `eslint-plugin-jsx-a11y` in lint (not installed yet — add it in M2).
- Manual, once per milestone, on the current milestone's routes: Tab-only traversal, one screen
  reader pass (NVDA on Windows — it is already on this machine's OS family), zoom to 200 %,
  and a 320 px reflow check.
- Contrast: every text/background pair in both themes checked. The dark-mode accent was chosen
  deliberately for this; verify the numbers rather than trusting the comment.
- Forms: label associated, error announced via `aria-describedby` + `aria-invalid` (the
  existing `Field` render prop already does this — use it, don't bypass it).
- Focus management: dialogs trap and return focus; route changes move focus to the `<h1>`.
- The skip link exists — keep it working on every layout, including `/admin`.
- Targets ≥ 24×24 px (2.2 AA), 44 px for primary mobile actions.

---

## 7. Performance budget

A mid-range Android on campus wifi is the reference device, not this laptop.

| Metric | Budget | Checked |
| --- | --- | --- |
| LCP (mobile, throttled) | < 2.5 s | M8, and after any layout change |
| CLS | < 0.1 | every milestone close |
| INP | < 200 ms | when a route gains client interactivity |
| Client JS per route | < 130 kB gzip for feed/profile; < 200 kB anywhere | per PR that adds a client component |
| Images | `next/image` everywhere; no layout-shifting uploads | M7 with storage |

Server Components do the reading (the architecture already says this): a client component is
justified in a PR body or it does not ship.

---

## 8. Copy standards

The house voice is already set in the landing page and the legal drafts: plain, second person,
no exclamation marks, no marketing adjectives. Rules:

- **Empty states name the reason and offer one way forward.** "Your feed is empty because you
  have not connected with anyone yet. → Find people at your university". Never just "No data".
- **Errors say what happened and what to do.** "That username is taken. Try another." Not
  "Invalid input", never a Postgres message, never an apology.
- **Planned features say they are planned and do not pretend.** `PlannedFeature` already
  carries the status text; keep using it rather than writing new optimistic copy.
- **Nothing is called "coming soon"** if it is not scheduled in a milestone on the board — the
  board is the source of truth for what is scheduled, so "coming soon" must be reducible to an
  issue number.
- British spelling in user-facing copy (`organisation`, `licence`), consistent with the docs.

---

## 9. UX review checklist — every PR that touches the interface

1. Four states: loading, error, empty, content.
2. Renders at 360 px without horizontal scroll; tap targets ≥ 44 px for primary actions.
3. Keyboard only: reachable, operable, focus visible, focus returned after dialogs.
4. Dark mode checked on the same screen.
5. Every control does something; nothing decorative; no invented number.
6. Destructive action confirmed with the object named.
7. Copy follows §8; no apologetic or robotic error text.
8. `build-status.ts` still true after the change.
9. No new token, shadow or colour without a one-line reason in `globals.css`.
10. axe clean on the touched route.
