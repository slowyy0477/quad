# Product

## Name

The working brand is **Quad** — the campus green where students actually meet.

> Note: this document originally said the name lives in `src/lib/config/brand.ts`. That
> file does not exist. The name currently appears in the layout metadata, the logo
> component and the footer. Centralising it is worth doing before any rebrand, and is
> not worth doing before then.

## The five questions

Every screen is judged against these. If a screen answers none of them, it should not
exist.

1. **Who am I?** → profile, university, skills, achievements
2. **What am I learning?** → daily log, streak, semester goals
3. **What am I building?** → projects, ideas, progress
4. **Who can I build with?** → discovery, follows, connections, team finder, chat
5. **What should I do next?** → dashboard next-actions, open goals, project help requests,
   deadlines

Question 5 is the retention mechanic. A student who opens the app and immediately sees
"log today's learning · 2 goals due this week · Maria asked to join Orbit" has a reason to
come back tomorrow. A student who sees an empty feed does not.

## What makes this not-just-a-social-network

A post on this platform is attached to something real — a project, a goal, a skill, a
semester. The feed is a byproduct of work, not the product. Concretely:

- Creating a project update *offers* to post it. Posting is the side effect.
- Completing a goal can be shared. The goal is the primary object.
- "Looking for teammates" is a structured record with required skills and slot counts, not
  a text post that decays.
- A profile is a portfolio with evidence: skills link to the projects that used them.

## Honesty rules

These are product rules, enforced in code review. They exist because the failure mode of
a project this size is a beautiful shell.

1. **No invented numbers.** Every count, percentage, streak, and chart is a query over
   stored rows. If we cannot compute it, we do not show it.
2. **No decorative controls.** A button either performs its action or is not rendered.
   Features that are planned but not built are absent, or shown with an explicit
   "Coming soon" state that is visibly not interactive.
3. **No simulated activity.** No fake users, fake chat, fake notifications. Development
   seed data lives behind a flag and is labelled in the UI (`SEED_BANNER`).
4. **Skill levels are self-declared.** The UI says so. We do not imply verification we
   cannot perform.
5. **Unavailable is a valid state.** "Session list requires the Supabase Admin API and is
   not available on this plan" is a better answer than a fabricated device list.

## Feature status

**The authoritative list is [`src/lib/build-status.ts`](../src/lib/build-status.ts),
rendered by the running application at `/status`.** It is code so that a placeholder
page and the status page cannot drift apart — `PlannedFeature` reads its own state from
the same list. This table is a summary of it and will go stale; the page will not.

Four states, with their exact meanings:

| State | Means |
| --- | --- |
| **working** | usable end to end by a real user, once Supabase is configured |
| **partial** | real but incomplete; the missing part is named on the page itself |
| **schema-only** | tables, RLS policies and tests exist. **No interface.** Nothing a user can do. |
| **planned** | designed, not built. The route says so instead of showing a mock-up. |

As of the last measurement: **5 working, 2 partial, 11 schema-only, 7 planned** — 25
tracked features.

| Domain | Status | Note |
|---|---|---|
| Database schema + RLS | working | 15 migrations, 52 tables, 292 tests |
| Design system | working | tokens, primitives, accessible `Field` |
| Auth — email, Google, reset, sign-out | working | not yet run against a live project |
| Legal + guidelines pages | working | **drafts**, banner-marked, need legal review |
| Build status page | working | this honesty mechanism itself |
| Feed + posts | partial | real read/write; no likes/comments UI, no ranking, no pagination |
| Documentation | partial | 8 of the planned documents exist |
| Profiles | schema-only | |
| Universities / faculties / programmes | schema-only | |
| Social graph (follow, connect, block) | schema-only | |
| Skills + endorsements | schema-only | |
| Projects + members + collaboration | schema-only | |
| Idea vault | schema-only | |
| Messaging | schema-only | tables + policies tested; no UI, no realtime |
| Notifications | schema-only | trigger-generated writes work; nothing displays them |
| Semesters / goals / daily log | schema-only | |
| Achievements | schema-only | |
| Opportunities + events | schema-only | |
| Onboarding | planned | new accounts get a placeholder username |
| Search | planned | migration `0018_search` unwritten |
| Reports / moderation | planned | `0016_moderation` unwritten — **launch blocker** |
| Bug reports | planned | |
| Admin + audit log | planned | route gated, no pages |
| Uploads / storage | planned | `0020_storage` unwritten; no upload path exists |
| Rate limiting | planned | `0017_rate_limits` unwritten — **launch blocker** |

Nothing in this table is rounded up. A feature with a beautiful page and no working
action is `planned`, not `partial`.


## Deliberately out of MVP scope

Schema and module boundaries leave room for these; none of them block launch.

GitHub sync · AI assistant/mentor · mentorship matching · video calls · university email
verification · clubs and organisations · course communities · resource library ·
internship tracker · certificates · reputation scores · native mobile app.

## Monetisation posture

No ad code ships until the site meets programme policy, and none ships at all while the
platform has no users.

> Note: this document originally described `components/shared/AdSlot.tsx`. It does not
> exist, and there are no ad slots in the current layout — which is the correct state
> for now. When they are added the constraints are: structurally forbidden in
> `/messages`, in `/admin`, and on any moderation surface; never positioned where a
> mis-tap hits an ad instead of the control beside it; reserved regions that render
> `null` rather than a placeholder, so an empty slot costs the layout nothing.

## Honesty rules — status

The five rules above are held, and here is the evidence rather than the assertion:

- No number anywhere in the UI is invented. The only counts rendered are
  `like_count`/`comment_count` on a post, which are trigger-maintained columns, and the
  feature counts on `/status`, which are computed from the feature list and carry the
  caveat that they count list entries, not usage.
- No decorative controls: unbuilt routes render `PlannedFeature`, which states the
  feature's real status and offers no fake affordance. Post like/comment counts render as
  **static text**, not as buttons, precisely because clicking them does nothing yet.
- With Supabase unconfigured, every form renders `disabled` under an explanation, rather
  than looking operational and failing.
- No seed data exists, so no fake user can leak into production.
- Skill levels are described as self-declared in the schema comments; the UI that will
  display them is not built, and must repeat it when it is.

