# GitHub management

How this project is run from here: the repository, the labels, the milestones, the board, the
flow and the cadence. Written for one person with 10–15 hours a week, so everything is
deliberately small — a process you cannot keep during exam week is worse than none.

Everything in this document has a mechanical half: [`scripts/github/bootstrap.mjs`](../../scripts/github/bootstrap.mjs)
reads [`issues.json`](issues.json) and creates the labels, milestones and issues on the
repo. Prose that says "create a label" is a plan nobody executes; a script that does it is
the plan.

---

## 1. Repository

| Setting | Value |
| --- | --- |
| Owner / name | `slowyy0477/quad` |
| Visibility | **public** — the point is a portfolio read; it is also honest about being unfinished |
| Description | Quad — a university student network for identity, projects, collaboration and learning. Next.js 16 + Supabase, authorisation enforced in Postgres. |
| Topics | `nextjs` `supabase` `postgres` `row-level-security` `typescript` `tailwindcss` `student-project` `university` |
| Default branch | `main`, protected |
| Licence | MIT (§ M0) |

**Before the first push:** `git grep -nIE "eyJ|sb_secret_|sb_publishable_"` must return nothing
in tracked files. `.env.local` is git-ignored, which has been checked
(`git check-ignore -v .env.local` → matches `.env.*`).

---

## 2. Labels

Seventeen, created by the bootstrap script. Area × type is the whole taxonomy: an area label
says where, a type label says what kind of work, and nothing else is needed.

| Group | Labels |
| --- | --- |
| Area | `area:db` `area:app` `area:ui` `area:tests` `area:ci` `area:docs` `area:ops` `area:safety` |
| Type | `type:feature` `type:verification` `type:bug` `type:chore` `type:design` `type:honesty` |
| Flow | `blocker` `good-first-issue` `needs-decision` |

Two of these carry weight beyond bookkeeping:

- **`type:verification`** — the work proves that something already written actually runs. In a
  repository where 90% of the code has never met a real database, this is not a lesser task type.
- **`type:honesty`** — the change makes a claim in the repo true again (a status entry, a
  document, a comment). It exists because the honesty mechanism drifted once already (F3), and
  drift is easiest to catch when it has a label you can filter on.

---

## 3. Milestones

Nine, matching [PLAN.md](PLAN.md) §4. Each has a due date derived from the cadence, and a due
date that slips is re-dated rather than left wrong.

| Milestone | Issues | Size | Target |
| --- | --- | --- | --- |
| M0 — Freeze and make honest | 8 | 3 sessions | week 1 |
| M1 — Prove it against a live database | 6 | 4 sessions | week 2–3 |
| M2 — Identity and people *(finish line A)* | 12 | 8 sessions | week 4–6 |
| M3 — A feed worth returning to | 7 | 8 sessions | week 7–9 |
| M4 — Projects and collaboration | 8 | 10 sessions | week 10–13 |
| M5 — Talking to people | 4 | 8 sessions | week 14–16 |
| M6 — Learning and discovery | 6 | 10 sessions | week 17–20 |
| M7 — Safety and operations | 7 | 10 sessions | week 21–24 |
| M8 — Launch readiness *(finish line B)* | 6 | 6 sessions | week 25–27 |
| **Total** | **64** | 67 sessions | ~27 weeks at 12 h/week |

Only one milestone is open at a time. The next one is opened at the close of the current one,
not earlier — a board with four columns of work in progress is a board that measures hope.

---

## 4. Issues

Sixty-four issues, one per deliverable, each carrying acceptance criteria that can be checked
by a command or a click. The manifest is the source of truth; the GitHub issues are generated
from it, so editing an issue in the UI and the manifest separately is how they drift.

Every issue follows the same shape, and the template enforces it:

```
Context — what is true today, with the evidence (file, line, command output)
Do — the changes, bounded
Acceptance — checkboxes, each verifiable, each an assertion rather than an adjective
Evidence — what the PR body must contain (a screenshot, a command result, a diff)
```

The rule that keeps this honest: **an issue that cannot state how its completion will be
checked is not ready to be worked on.** It goes back to `needs-decision`, not into a sprint.

---

## 5. Project board

A GitHub Project (v2) named **Quad**, one view per need:

| View | Layout | Shows |
| --- | --- | --- |
| **Board** | columns by status | `Todo` · `In progress` (limit 1) · `Review` (limit 2) · `Done` |
| **Current milestone** | table filtered to the open milestone | order of work today |
| **By area** | table grouped by `area:*` | where the effort is going |
| **Blockers** | table filtered to `blocker` | what stands between here and a finish line |
| **Verification debt** | table filtered to `type:verification` | how much of the codebase has never run |

Custom fields: `Milestone` (single select), `Area`, `Size` (S/M/L in sessions), `Evidence`
(text — the link or command that proves it).

Board rules:

1. **`In progress` holds one card.** The WIP limit is the whole discipline; two half-built
   features is a project with no demonstrable state.
2. Nothing moves to `Done` without its acceptance boxes ticked and CI green.
3. A card that has not moved in two weeks is either split or closed — an issue nobody starts is
   usually an issue that was never small enough.

> **Token scope note:** creating a Project requires the `project` scope, which the current
> `gh` token does not have (`gist, read:org, repo, workflow`). Run `gh auth refresh -s project`
> once before the bootstrap script's board step. The script detects this and says so rather
> than failing mid-way.

---

## 6. Cadence

| When | Ritual | Minutes |
| --- | --- | --- |
| Start of each session | Open the current-milestone view, take the top card, nothing else | 2 |
| End of each session | Commit, push, open the PR, let CI answer. Red CI becomes tomorrow's first card | 5 |
| Weekly (Sunday) | `docs/review/YYYY-WW.md`: what closed, what moved, what is blocked, which decision changed, and re-read `/status` against reality | 20 |
| Milestone close | Deploy to preview, demo to one person who is not him, update the README's honest state table, close the milestone, open the next | 60 |
| Finish line | Tag `vX.Y.Z`, release notes from the closed issues, write the milestone review | 90 |

The weekly review is four bullets, not a report. Its only real purpose is to catch drift —
a status entry that is no longer true, an estimate that has slipped twice, a decision taken
without being written down.

---

## 7. Automation

| Script / workflow | Does |
| --- | --- |
| `scripts/github/bootstrap.mjs` | Creates labels, milestones and issues from `issues.json`; idempotent (re-run safely); `--dry-run` prints what it would do; optionally creates the Project and adds every issue to it |
| `.github/workflows/ci.yml` | typecheck → lint → database suite → build on every push and PR; required on `main` |
| `.github/workflows/e2e.yml` (M1) | Playwright against a dedicated test project, traces uploaded on failure |
| `.github/workflows/schema-drift.yml` (M1) | `npm run db:check` on `main` only, so a deployed schema that has drifted from the migrations is announced rather than discovered |
| Dependabot | Weekly, grouped, one PR for the minor/patch batch |

Usage:

```bash
node scripts/github/bootstrap.mjs --dry-run     # print the plan
node scripts/github/bootstrap.mjs               # create repo-labels-milestones-issues
node scripts/github/bootstrap.mjs --project     # also create the board and add every issue
```

---

## 8. Day-to-day flow

```bash
# take a card
gh issue list --milestone "M2 — Identity and people" --limit 20

# branch
git switch -c feat/42-mobile-navigation

# verify before pushing — always, not sometimes
npm run verify

# push and open the PR with the template filled in
git push -u origin HEAD
gh pr create --fill --web

# after review (by yourself, against ENGINEERING.md §10)
gh pr checks
gh pr merge --squash --delete-branch
```

Conventional commits: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, plus the scope
(`feat(feed): …`). The commit body states the *why*; the diff already states the what. The PR
body carries the Definition of Done checklist and, for anything user-visible, a screenshot —
because the reviewer is the same person who wrote it, and the screenshot is the thing that
catches what the author assumed.

---

## 9. What gets measured

Four numbers, no dashboard:

| Metric | Where | Healthy |
| --- | --- | --- |
| Issues closed this week | weekly review | ≥ 1 |
| Time in `In progress` | board | < 1 week per card |
| `npm run verify` duration | CI log | < 6 min (549 s locally with a cold cache) |
| Test count by layer | TESTING.md | grows in all four rows, not only the database row |

Deliberately not measured: lines of code, commits per day, "percentage complete". The
`/status` page already answers the only progress question that matters, and it answers it in
the terms a user cares about.

---

## 10. If the project is dropped for a month

The recovery ritual, so a gap does not become an ending. The main risk on a solo project is
most of this plan's value evaporating alongside his free hours:

1. Read `docs/review/*.md` — the last three files, not all of them.
2. Read the last commit messages, newest first, until they stop making sense (usually five).
3. Re-read [PLAN.md](PLAN.md) §1 and run the measurement table again. The numbers will have
   changed; the findings either still apply or are fixed, and both are useful.
4. Run `npm run verify` and `npm run db:check`. A project whose tests and schema are green
   after a month away is a project that was built properly — that is the whole point of M0 and M1.
5. Take exactly one card from the current milestone. Not the most interesting one, the top one.
