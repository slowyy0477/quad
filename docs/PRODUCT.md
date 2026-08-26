# Product

## Name

The working brand is **Quad** — the campus green where students actually meet. It is
defined in exactly one place, [`src/lib/config/brand.ts`](../src/lib/config/brand.ts).
Change that file and the whole app follows. Nothing else hard-codes the name.

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

Honest status of every domain in the spec. Updated as work lands.

| Domain | Status |
|---|---|
| Architecture, conventions, docs | in progress |
| Database schema + RLS | in progress |
| Auth (email, Google, reset, sessions) | pending |
| Onboarding | pending |
| Design system | pending |
| Profiles | pending |
| Universities / departments / programs | pending |
| Social graph (follow, connect, block) | pending |
| Feed + posts + comments | pending |
| Projects + members + collaboration | pending |
| Idea vault | pending |
| Team finder | pending |
| Messaging (realtime) | pending |
| Notifications | pending |
| Semesters / goals / daily log | pending |
| Skills | pending |
| Achievements | pending |
| Search | pending |
| Opportunities | pending |
| Events | pending |
| Reports / moderation | pending |
| Bug reports | pending |
| Settings | pending |
| Admin + audit log | pending |
| Ad placement slots (empty) | pending |
| Legal pages (require human review) | pending |

## Deliberately out of MVP scope

Schema and module boundaries leave room for these; none of them block launch.

GitHub sync · AI assistant/mentor · mentorship matching · video calls · university email
verification · clubs and organisations · course communities · resource library ·
internship tracker · certificates · reputation scores · native mobile app.

## Monetisation posture

Ad slots are defined as empty, reserved layout regions in feed, explore, and public
content pages (`components/shared/AdSlot.tsx` renders `null` unless
`NEXT_PUBLIC_ADS_ENABLED`). No ad code ships until the site meets programme policy. Ads
are structurally forbidden in `/messages`, `/admin`, and any moderation surface.
