# Bulla — August archive comparison

Reviewed: 31 October 2026. Source inspection, not runtime acceptance.

## Folder inventory and provenance

The requested archive `C:\Users\Bullza\Documents\Codex\2026-08-26` contains
two different outputs:

| Variant | Actual contents | Treatment |
| --- | --- | --- |
| `files-pasted-by-the-user-university\outputs\university-student-network` | Eight Next.js pages, six short docs, one foundation migration, Supabase client factory and username tests; 27 non-env files | Original requirements/scaffold reference |
| `ju\outputs\university-student-network` | Four HTML/CSS/JS/README files; eight hash-switched views; fixed sample people, dates and metrics | UI reference only |

The second README explicitly describes the demo:
[ju README](C:/Users/Bullza/Documents/Codex/2026-08-26/ju/outputs/university-student-network/README.md:3).
Its “Published” and “Message sent” handlers only clear a form or change the DOM:
[demo handlers](C:/Users/Bullza/Documents/Codex/2026-08-26/ju/outputs/university-student-network/app.js:29).
The first signup form also has no persistence action:
[scaffold signup](C:/Users/Bullza/Documents/Codex/2026-08-26/files-pasted-by-the-user-university/outputs/university-student-network/app/signup/page.tsx:2).

Neither is a completed backend or an alternative production-ready app.
The active repository had 49 page implementations and 21 migrations before
this recovery slice. It is the correct base to preserve, inspect and finish.

## Requirements worth carrying forward

- Task-first context: personal goals, next useful actions, relevant projects
  and upcoming events. Compute it from real data.
- Profile as a portfolio: permitted projects, learning evidence and activity,
  not just biography/skills.
- People discovery by university, department and self-declared skills.
- Project roles, member applications and idea-to-project conversion.
- Structured feed posts tied to actual projects or goals.
- Personal learning records, honest achievements and semester context.
- Privacy/block controls, useful messaging, moderated university requests.

## Differences to resolve

1. The archive promises publication choice, but both old and current schemas
   default profiles to public. Make onboarding visibility explicit; do not
   imply consent behavior that is not implemented.
   [original copy](C:/Users/Bullza/Documents/Codex/2026-08-26/files-pasted-by-the-user-university/outputs/university-student-network/app/onboarding/page.tsx:1).
2. Original opportunity requirements call for reviewed/admin-controlled
   listings. Current creation is direct. Define trust/review policy and report
   coverage for opportunities/events before public launch.
   [original requirement](C:/Users/Bullza/Documents/Codex/2026-08-26/files-pasted-by-the-user-university/outputs/university-student-network/app/opportunities/page.tsx:1).
3. The old UX plan suggests application tracking. The current opportunity
   model stores bookmarks, not proof of applications. Keep this honest;
   implement a personal tracker separately if it is still wanted.
4. The old prototype contains skill percentages and “active now” displays.
   Do not import those fictional measurements into the real app.
5. The old visual plan and newer design disagree. Use the current Bulla
   [design direction](DESIGN.md); retain the newer navigation/form lessons.
6. Local profile writes and counters were incomplete even though profile
   screens existed. Fix and test the actual journey, not only its appearance.

## New first-slice work informed by this comparison

- Feed sidebar now uses actual personal projects and goals.
- Project attachments link to existing project detail routes.
- Local profile onboarding/editing and graph-count correctness are a
  separately tested recovery task.

Still outstanding: richer public portfolio sections, skill-based people
search/paging, real upcoming-event context, clear initial publication choice,
board review policy and broader report coverage.

The archive files are intentionally unchanged. They remain evidence and a
design reference, not a second active source tree.
