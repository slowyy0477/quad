# Bulla — campus commons design direction

Reviewed: 31 October 2026. This document supersedes the conflicting visual
directions in `docs/plan/UX.md` and `docs/plan/DESIGN.md`. It does not supersede
their useful accessibility or permission requirements.

## Intent

Bulla helps a student find people, share real work, collaborate and keep a
record of learning. It should feel like a useful place on campus, not an
enterprise dashboard or a generic startup landing page.

The newer implementation's grouped navigation, native fonts, accessible
account forms and honest empty states are retained. The new identity uses
cool neutral surfaces, deep jade actions and quiet blue-gray structure.
This is an original design judgment, not a claim that a particular palette is
objectively “the best”.

## Research translated into decisions

- Keep navigation, context and page-specific actions in predictable locations.
  Reduce visual competition without hiding useful information. Apply this to
  Bulla's header, desktop navigation and page headings.
  [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh).
- Let people discover one another through work and interests rather than
  fabricated popularity scores. Make projects, ideas and learning records
  meaningful objects, not decoration.
  [Are.na's product explanation](https://www.are.na/about).
- Use a linked error summary as well as inline errors in multi-field forms;
  focus the summary after an unsuccessful submission. Keep the entered values.
  This remains a rollout requirement for older domain forms.
  [GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/).
- Design and test for keyboard navigation, unobscured focus, usable targets
  and password-manager-friendly authentication. Aim for WCAG 2.2 AA; the
  project's preferred 44px primary hit targets exceed the AA minimum where
  applicable. A design specification alone is not conformance evidence.
  [W3C's WCAG 2.2 additions](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/).

## Identity and tokens

The implementation source of truth is `src/app/globals.css`.
`src/lib/brand.ts` owns public metadata and installation identity.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#F7F8FA` | `#10161E` |
| Raised surface | `#FFFFFF` | `#18212C` |
| Inset surface | `#EDF0F4` | `#202B39` |
| Main text | `#1C2634` | `#EDF3FA` |
| Supporting text | `#526174` | `#B6C2D1` |
| Metadata | `#637083` | `#9EAFC2` |
| Action | `#126B56` | `#91E2C8` |
| Text on action | `#FFFFFF` | `#13382E` |
| Major border | `#C5CDD7` | `#45586D` |
| Input border | `#7C8999` | `#70869E` |

The original code-native Bulla mark is a lowercase **b** with a conversation
detail. Raster installation icons are derived from that SVG, not generated
photography. Previous icons remain on disk for recovery; the active manifest
uses only Bulla's new assets.

Use a native sans-serif stack. Hierarchy comes from type size, spacing and
weight. Body is 16px, secondary text 14px, metadata at least 12px. Phone form
controls remain 16px. Use mono only for real identifiers/code and tabular
figures for aligned measurements.

Controls have 8px corners, surfaces 12–16px. Use borders and luminance for depth.
Content surfaces stay opaque. The user's later request for modern effects adds
a lightly translucent sticky header, a restrained gradient behind original
decorative campus artwork, 180ms hover/press feedback and a short page entrance.
No infinite motion, glowing buttons, arbitrary emoji icons or stacked decorative
panels. Honor reduced motion; content must never depend on an animation.

## Information architecture

Primary mental models:

- **Feed:** post, ask a question, read updates; Following remains URL-addressed.
- **Discover:** people, projects, ideas, events and opportunities; filters belong
  beside results rather than in a separate marketing screen.
- **Learn:** personal goals, study logs, semesters and real achievements.
- **Messages:** inbox and conversations, with honest connection/read state.
- **Profile:** identity, work and visibility; settings/help remain reachable.

The campus menu exposes every real destination on intermediate screen sizes.
Desktop signed-in screens share one grouped left navigation. The feed keeps a
central composer and a small optional work/learning column, without repeating
the navigation there or in the header. The local-preview disclosure is a
persistent compact header link; the footer is no longer a second large menu.
The university directory uses bounded campus cards and a collapsed request
form rather than showing every secondary action at once. On phones, the fixed
labeled bottom navigation appears only when signed in, and content reserves
its height plus the device safe-area inset.

Do not silently add unsupported destinations such as Saved, Resources or
Clubs. Implement the route and permissions first, then add its navigation.

## Screen rollout and completion criteria

| Screen family | Design work | Required behavior |
| --- | --- | --- |
| Landing | New Bulla identity, concise introduction and functional wayfinding | No fictional student counters, testimonials or invented product screenshots |
| Account entry | Form-first layout; concise mobile context | Password managers, validation, pending state, preserved fields; providers offered only when supported |
| Feed | Persistent navigation, compact composer, real personal context | Post/like/comment/save/permalink and paging work after reload; rejected drafts survive |
| Profile | Identity plus portfolio evidence | Visible projects and learning/activity only when their own permissions permit; accurate graph counts |
| Discovery | Search with university/department/skill filters | Bounded results, URL filters, empty/no-access states and stable paging |
| Projects/ideas | Work first, membership/application controls second | Role checks, ownership, join decisions, conversion and linked updates |
| Messaging | Conversation list and readable thread | No duplicate sends; reconnect/reconcile; privacy/block enforcement; truthful unread indicators |
| Learning | Semester context, goals and a simple timeline | Real records, timezone-correct streaks; no invented mastery percentages |
| Boards/events | Clear dates, host and action | Expired listings, external-link warnings, RSVP capacity/timezone and report/review controls |
| Settings/admin | Plain forms, clear consequences | Reauthentication for sensitive changes, staff-only actions, audit trail and deletion/export controls |

**Implemented in the first recovery slice:** brand/tokens, public landing,
shared shell/PWA identity, feed structure, project-attachment navigation.
The complete redesign of every feature screen is still outstanding.

**Completion-phase public checks:** changed shared shell/landing/university
directory passed scoped lint and a ten-screen Playwright inspection at
1440px/390px, with HTTP 200 and no horizontal overflow/client exceptions.
Screenshots are in the D-drive task's
`screenshots/inspect-2026-10-31T13-21-09-294Z`. Signed-in, all-device, contrast
and full-core acceptance are still separate work.

## State and content rules

Each data screen needs loading, empty, error, populated, forbidden and
submission-pending states where applicable. A skeleton does not replace
error recovery. Retry must not duplicate a write. Show field errors beside
the field; distinguish no results from a failed query.

Write like a helpful campus tool: “No projects yet”, “Save changes”, “Who can
see this?” Avoid “unlock your potential” language, invented verification,
fake online badges, unexplained percentages and endless congratulatory copy.

Example seed content is development data, not proof of real users or usage.
Public previews must disclose local/development mode.

## Acceptance checklist

Scoped evidence from the 31 October recovery pass:

- [x] Landing, login, signup and setup tested at 320/360/390/768/1024/1440px
  in light and dark, with no document horizontal overflow.
- [x] Bulla metadata/manifest/icon routes, legacy theme preference and actual
  request nonce behavior checked in the browser.
- [x] Local onboarding/profile/post/reload/logout journey, 390px signed-in
  navigation, dialog Escape/trigger focus and revoked-cookie replay passed.
- [x] Visual review corrected the decorative ordinal labels; the reflow
  regression verifies that each number stays on one line.

These do not complete the whole-app checklist below:

- [ ] Inspect 320, 360, 390, 768, 1024 and 1440px, in light and dark.
- [ ] No horizontal document overflow, clipped names or hidden last actions.
- [ ] Keyboard-only navigation, skip link, visible focus, dialog Escape and
  trigger-focus return; focus is not obscured by fixed navigation.
- [ ] Screen-reader labels, associated field errors and live submission status.
- [ ] 200% zoom and narrow reflow; reduced motion and device safe areas.
- [ ] Contrast checks for text, controls, focus and disabled/error states.
- [ ] Long names, multilingual content, empty datasets and network failures.
- [ ] Android install and iOS Add to Home Screen; correct Bulla icons/name;
  offline screen never exposes private cached pages.
- [ ] Test with 3–5 students on real phones before claiming the design is easy.

Performance targets at the 75th percentile: LCP at most 2.5 seconds, INP at
most 200ms and CLS at most 0.1. These are targets, not measured outcomes.
[Core Web Vitals thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds).
