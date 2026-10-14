# Contributing

Quad is a one-person project with a process borrowed from teams, because the failure mode
of a project this size is a beautiful shell — an interface over a hole. These are the rules
that keep that from happening.

## Before you push

```bash
npm run verify      # typecheck → lint → 296+ database tests
```

It takes about nine minutes on the machine this was built on. It is not optional; the CI
workflow runs exactly the same command, so skipping it locally only moves the failure.

## The rules that are not style preferences

1. **Authorisation lives in Postgres.** Row-level security, policies and column-level
   `GRANT`s decide what anyone may read or write. Hiding a button is never a permission.
   A new table without RLS and a policy fails `tests/db/schema.test.ts`, on purpose.
2. **A new database function needs a declared audience.** Grant `EXECUTE` to exactly the
   roles that need it. The same test fails until you decide — the decision is the feature.
3. **Every table you touch needs a permission test** in `tests/db/`, in the three-direction
   shape: the owner can, an unrelated user cannot, and an unrelated user cannot do it by
   substituting an ID. The third is the one that matters.
4. **No invented numbers.** Every count, percentage and streak is a query over stored rows.
   See PRODUCT.md rule 1. A plausible number that is not computed is a lie with a nicer font.
5. **No decorative controls.** A control either performs its action or is not rendered.
   Unbuilt features are absent, or rendered through `PlannedFeature`, which reads its own
   status from `src/lib/build-status.ts`.
6. **Update `build-status.ts` in the same commit** as the feature that changes its truth.
   `/status` is the page that keeps this project honest; it is only allowed to be right.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`) with a
  scope when it helps: `feat(feed): …`. The body states *why*; the diff states what.
- Migrations are numbered, ordered and immutable once applied. There are no
  down-migrations: a down-migration that has never been run is a false sense of safety.
  Numbering is reserved from the next free number, and the number is reserved in the issue
  that writes it.
- Server Components read; Server Actions write. A client component needs a reason in the PR
  body (state, an event, a browser API) or it does not ship.
- Postgres error codes are mapped to sentences. The raw message never reaches the browser.
- No new colour, shadow or radius without a one-line reason in `globals.css` next to the
  reasoning that is already there.

## Where things are

| Path | What |
| --- | --- |
| `docs/plan/PLAN.md` | the plan to finish it — audit, findings, finish lines, milestones |
| `docs/plan/UX.md` | the interface contract: UI kit, screens, accessibility and performance budgets |
| `docs/plan/ENGINEERING.md` | code standards, Definition of Done, CI, test strategy |
| `docs/plan/GITHUB.md` | how the work is run: labels, milestones, board, cadence |
| `docs/plan/SCHEMA.md` | generated schema reference — 52 tables, every column |
| `docs/ARCHITECTURE.md` | how the system is put together, and where the code differs from the design |
| `docs/SECURITY.md` | threat model, the four authorisation layers, and what is *not* protected yet |

## Reporting a bug

Use the issue templates. A report that says what happened, what should have happened, and
how to reproduce it is worth ten that say something is broken.
