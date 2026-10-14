<!--
  The Definition of Done, from docs/plan/ENGINEERING.md §4, as a form. The reviewer here is
  the person who wrote the diff, so the checklist is doing the job a colleague would:
  asking the questions the author already assumed the answers to.
-->

## What this changes

<!-- One paragraph. What is different for a user after this merges? -->

Closes #

## Why

<!-- The decision, and the alternative that was rejected. If the diff already says why,
     say "self-evident in the diff" and move on. -->

## Verified — with the command or the click, not an adjective

- [ ] `npm run verify` passes locally
- [ ] The changed route(s) opened in a browser and worked
- [ ] *(if a migration)* `npm run db:push` then `npm run db:check` on a real project
- [ ] *(if a policy changed)* a permission test fails when the policy is dropped

<!-- Paste the command output, or name the route and what it did. -->

```
$ npm run verify
...
```

## Definition of Done

- [ ] Permission test exists for every table touched — owner can, stranger cannot, stranger cannot by ID substitution
- [ ] Route ships four states: loading, error, empty, content
- [ ] Every number rendered is a query over stored rows; every control does something or is not rendered
- [ ] `src/lib/build-status.ts` updated in this PR if a feature's real state changed
- [ ] Works at 360 px and with the keyboard only; focus visible; form errors announced
- [ ] No service-role key read outside `lib/supabase/admin.ts`; no raw Postgres error reaching the browser
- [ ] `docs/plan/` updated if this changes the plan, a milestone or the status of an issue

## Screenshots / before and after

<!-- For anything visible. A screenshot catches what the author assumed. Delete if N/A. -->

## Deliberately not done

<!-- What this PR leaves out, and which issue picks it up. Every PR of mine has one of
     these; writing it down is how scope stays honest. -->
