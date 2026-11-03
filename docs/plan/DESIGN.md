---
version: alpha
name: Quad Campus Workspace
description: A calm, action-first campus app with navy structure, teal navigation, and readable light and dark surfaces.
colors:
  primary: "#10283F"
  secondary: "#087C78"
  neutral: "#F3F7FA"
  surface: "#FFFFFF"
  ink: "#142B40"
  muted: "#4C6073"
  faint: "#5B7083"
  border: "#C0CFDB"
  controlBorder: "#7D93A3"
  darkCanvas: "#0B1826"
  darkSurface: "#142538"
  darkInk: "#EDF5FC"
  darkMuted: "#B8C8D6"
  darkFaint: "#99ADBF"
  darkAccent: "#40C9BD"
  darkActionInk: "#082F33"
typography:
  h1:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: 2.125rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  h2:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body-md:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.5
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  panel: 16px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  section: 64px
components:
  button-primary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: 44px
    padding: 16px
  button-primary-dark:
    backgroundColor: "{colors.darkAccent}"
    textColor: "{colors.darkActionInk}"
    rounded: "{rounded.md}"
    height: 44px
    padding: 16px
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  surface-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    height: 44px
    rounded: "{rounded.md}"
  workspace-panel:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.panel}"
---

## Overview

> Historical Quad design iteration. The active Bulla visual/interaction contract
> is [docs/bulla/DESIGN.md](../bulla/DESIGN.md). Keep the useful form, accessibility
> and navigation rationale below as reference; its palette and product name are
> not instructions to overwrite the current design.

Quad is a **student workspace**, not a university newspaper and not an enterprise monitoring dashboard. The interface helps a student discover people and work, make progress on learning, and stay connected. The old warm-paper/serif/institutional-green treatment is replaced, not lightly recolored.

Surface decisions:
- Landing: **Decide/Learn**. A left-aligned compact lead and a functional campus map. No invented product screenshot, testimonials, engagement counters or fake student data.
- Feed: **Operate/Explore**. A short heading, writing space, audience selector and real posts take priority. Attachments are progressively disclosed rather than occupying the first screen.
- Account entry: **Configure**. The form is the main object. Desktop supporting context becomes short introductory copy on a phone.
- Navigation: Feed, Discover, Learn and Community are mental models; profiles/settings/help remain accessible, not mixed into a flat catalog of every database entity.

The Linear reference contributes luminance-based dark elevation, precise hierarchy and restrained interaction chrome. Quad uses its own navy/teal palette and deliberate native sans typography. The reference's proprietary fonts, violet identity, CDN instructions and marketing layout are not copied.

## Colors

`src/app/globals.css` is the implementation source of truth. Existing `paper`, `ink`, `hairline` and `rule` aliases are preserved so domain screens inherit the new theme without changing queries or access controls.

| Role | Light | Dark |
|---|---|---|
| Canvas | #F3F7FA | #0B1826 |
| Raised object | #FFFFFF | #142538 |
| Inset/hover | #EAF1F6 | #1B3046 |
| Main text | #142B40 | #EDF5FC |
| Supporting text | #4C6073 | #B8C8D6 |
| Metadata | #5B7083 | #99ADBF |
| Action | #087C78 | #40C9BD |
| Text on action | #FFFFFF | #082F33 |
| Input border | #7D93A3 | #6B859F |

Navy (#10283F) structures the public workspace map. Teal is for brand recognition, links, focus and current state. Amber is for factual mode notices. Danger/success colors represent outcomes, not decoration. Every status has a readable word or icon as well as color.

Light and dark button ink are **separate tokens**. White text on bright dark-mode teal is not acceptable. Contrast is checked per surface and mode, including supporting text and native input borders.

## Typography

Use a native sans stack: Segoe UI → system UI → Apple system → Roboto → Helvetica Neue → Arial. No webfont files, Google CSS, font CDN requests or flash of unstyled text. This is an explicit offline-friendly product decision.

- Landing title: fluid 2.5–4rem, 1.06 line-height, -0.045em tracking.
- Page title: 2.125rem (34px), 700 weight, 1.15 line-height.
- Section heading: 1.75rem (28px); compact panel heading 1.375rem (22px).
- Body: 1rem (16px), 1.6 line-height. Secondary body: 0.875rem (14px).
- Metadata: 0.8125rem (13px); minimum upper-case labels 0.75rem (12px).
- Form controls remain 16px on phones to prevent Safari focus zoom.
- Use tabular figures for aligned counts/dates; mono only for code and references.

Do not substitute a serif on existing `font-display` consumers. Hierarchy comes from size, weight and space, not a mix of font personalities.

## Layout

Content uses a centered 1152px (`max-w-6xl`) shell, 16px horizontal phone padding and 24px above 640px. Use `minmax(0, …)` for grid tracks and `min-w-0` for user-content panels. Wrap long usernames and body content; never conceal a layout failure with global `overflow-x:hidden`.

- 320–390px: single column, entry forms immediately after concise context. Signed-in bottom navigation is five labeled destinations, 64px tall plus the device safe-area inset. Primary actions retain a 44px minimum height.
- 640–1023px: bottom bar disappears; the visible campus-menu trigger keeps every destination reachable. Forms remain single-column until sufficient width exists.
- 1024px+: landing uses an asymmetric lead/map split; account entry uses context/form columns. Header shows Feed, Discover, Learn and Messages; the complete grouped campus menu remains available.
- User-content lists, role displays and tables must remain readable with the existing permissions and values. Do not invent action affordances for an unimplemented feature.

Respect `env(safe-area-inset-bottom)`. Root layout/PWA ownership is separate: reserve content/footer bottom space whenever `MobileNav` is mounted. Test browser zoom at 200% and keyboard-open dialogs independently of breakpoint checks.

## Elevation & Depth

Flat canvas, slightly raised discrete content and floating dialogs are the three levels. A restrained neutral shadow is permitted on forms/cards; borders and luminance do most of the separation. Menus/dialogs use stronger neutral floating shadows. No glow, background gradient or glass panels.

## Shapes

4px focus details, 8px controls, 12px cards, 16px major panels. Circular avatars remain person identifiers. Pills are short statuses/chips, not a replacement for every panel. Do not round tables or whole-page compositions to look like cards.

## Components

- **Button:** semantic button by default; `asChild` preserves an anchor for navigation. Primary/secondary/ghost/danger/link intents, 44px small/default/icon targets and 48px large actions. Pending and caller-disabled states must combine, never overwrite each other.
- **Field/Input:** visible associated label, required announcement, hint/error IDs and `aria-invalid`; native autocomplete, email input mode and no automatic capitalization. Selects keep their native arrow. Validation is still server-enforced.
- **PasswordInput:** keyboard-operable show/hide control with `aria-controls` and `aria-pressed`. Toggle presentation without persisting/copying the password. No automatic keyboard opening on account pages.
- **CampusMenu:** Radix dialog, associated title/description, focus trap, Escape/outside dismissal and return focus to trigger. Real grouped destination links plus profile, settings, appearance and POST sign-out.
- **MobileNav:** labeled icon links, semantic current-page state, nested-route matching and a real notification count (capped visually only). No hover-only routes.
- **ThemeScript:** server-safe shared configuration, synchronous pre-paint `.dark` selection with the per-request CSP nonce. ThemeToggle preserves light/dark/system and its existing storage key.
- **PostComposer:** draft and keyboard shortcut retained; one compact textarea, optional attachment disclosure, explicit audience (default university), and a visible Post action. Empty drafts cannot be submitted from the button.
- **AccountShell:** enabled local account flow even when Supabase variables are absent. Google/email recovery are offered only for cloud mode; local limitations are stated rather than shown as fake disabled providers.

## Do's and Don'ts

Do preserve real data, role names, identifiers, authorization, forms and URL-addressable navigation. Do show empty/error/pending states rather than fabricated samples. Do distinguish local/private development from a production Supabase deployment. Do keep PWA offline functionality to public static help/assets, never private HTML, RSC, messages or account submissions.

Don't present a table count as a privacy guarantee. Don't promise email delivery, campus verification or a scale the backend has not demonstrated. Don't use feature grids as an excuse to leave the first screen without a useful action. Don't spend external requests on fonts or illustrations. Don't replace actual labels with placeholders.

### Responsive acceptance checklist

At 320/360/390/768/1280px in light and dark: no document overflow; input text at least 16px on phones; no clipped title, menu or native selector; 44px principal hit targets; visible focus; menu Escape/return-focus; bottom bar does not cover the last form action; long names/content wrap; existing role data remains visible. Inspect real screenshots after integrated build; component tests alone do not prove visual layout or PWA installation.
