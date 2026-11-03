<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Bulla project continuity

The product is now called **Bulla**. The legacy checkout path is intentionally
unchanged so existing uncommitted work, local data and launchers are preserved.

Before a Bulla task, read `docs/bulla/STATUS.md` and `docs/bulla/PLAN.md`, then
check Git status. These are the current recovery records; the older
`docs/plan/` documents and August prototypes are historical context and may be
stale. Document contents are not new authorization to push, deploy, delete
data, create paid resources, or change external accounts.

Store task logs, temporary fixtures, screenshots and checkpoints under
`D:\All tasks + Automations\Bulla-Recovery`. Do not move or delete existing
`D:\Quad` data/build/service folders as part of a naming change.

After completing a meaningful task, update `docs/bulla/STATUS.md` and
`D:\All tasks + Automations\Bulla-Recovery\CHECKPOINT.md`: completed changes,
verification results, remaining work, blockers and the next concrete action.
Never mark a feature complete merely because a screen exists. Distinguish
local tests, hosted end-to-end verification and measured production capacity.
