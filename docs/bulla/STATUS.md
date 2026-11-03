# Bulla — current status and resume record

Updated: 3 November 2026, Asia/Karachi. The early public preview is hosted;
the application and full launch acceptance remain unfinished. This record
supersedes old running/next-step snapshots.
The complete previous record is preserved in [STATUS-HISTORY-20261102.md](STATUS-HISTORY-20261102.md).

## Resume first

- Active source: `E:\Uni-Social-Network`; `E:\Bulla` is only the workspace entry.
- Read AGENTS, this file, [PLAN.md](PLAN.md) and the D-drive checkpoint.
- Preserve pre-existing Git changes, existing accounts/media and
  owner preview. Do not replace it with either August prototype.
- Task drive: `D:\All tasks + Automations\Bulla-Recovery`.
- Update this record and `CHECKPOINT.md` after every meaningful completion:
  changes, actual verification, remaining work and exact next action.
- Main owns application integration and the only verification pool. Agents
  prepare disjoint task-drive source/test proposals without checks or servers.

## Current hosting request — 3 November 2026

### MFA setup QR compatibility repair — locally verified; deployment next

The owner reports the safe-setup-QR rejection during personal enrollment.
The provider's per-cell SVG format independently reproduces the rejection:
61 cells / 3,721 rectangles / 283,047 characters exceeded Bulla's 256,000-character
cap. Raised only the bounded input cap to 1,048,576 characters; SVG/content,
ownership, cookie persistence, role and fresh-MFA guards are unchanged.
Added realistic 61/97-cell positives and large malicious/oversized negatives.
No authenticator, account, password or role was changed or removed.

Independent native/integer raster decoding and isolated Chrome's actual form
image/white wrapper passed exact synthetic-URI equality. Chrome's 12/12 cases
cover 320/390/1440 widths, light/dark and DPR 1/2; this is synthetic image evidence,
not personal scanning or hosted staff access. Three earlier fractional
librsvg raster failures are retained, not accepted or erased. Task record:
`mfa-qr-20261103/PROGRESS.md` on the task drive.

Fresh main-only focused verification passed, actual exit 0: non-incremental
TypeScript, scoped zero-warning lint, **483/483 tests**, zero failures/skips
and **13/13 requested files actually executed**. Report:
`access-privacy-20261103/verify-2026-11-03T15-03-49-024Z-e07830de/REPORT.md`.
Current source correction is not yet deployed. Next: reviewed commit/snapshot
and cloud build with alias assignment withheld, exact-deployment inspection/
promotion and public privacy recheck. Do not advise repeated setup attempts
until the correction is live.
Latest read-only preflight reports zero verified/three unfinished TOTP setups;
no factor details, keys, codes or sessions were read. Earlier one-setup
guidance below retains its historical observation only.

### Owner staff assignment and diagnostic privacy — completed; personal MFA pending

The owner explicitly selected their existing personal account for admin and
moderator powers. Exact verified Auth UUID/email preflight passed: active,
confirmed, onboarded, not banned/deleted and no deletion pending.
The guarded one-row grant was rehearsed and rolled back, then committed.
Read-back confirms `admin`; admin includes every moderator capability, so no
redundant moderator row was added. Client staff-role INSERT remains denied.
Private approval/target evidence: task-drive
`access-privacy-20261103/PROGRESS.md`.

No password, email-verification state, profile data or MFA policy was changed.
The account has no verified authenticator yet. Personal TOTP enrollment at
`/settings/security` and live `/admin` assurance remain required; they cannot
be completed by storing an operator-controlled factor or bypassing MFA.

Read-only owner follow-up on 3 November confirms admin is still held,
**zero verified TOTP factors / one unfinished TOTP setup**. The owner asks
where the six-digit code comes from. Source inspection confirms the existing
setup/verification controls; the code is generated in the owner's authenticator
app after scanning Bulla's private QR, not sent by Gmail. An already-scanned
setup can use its app code; an unscanned setup whose QR was hidden requires
a fresh owner-created QR with a distinct authenticator name. No setup key,
code, password or session was read, and no factor/provider change occurred.
Next: owner finishes QR/app-code verification, then uses the resulting
`Continue to staff tools` link or `/admin`. Live staff access remains unaccepted.
Only continuity records changed in this follow-up; no redeployment is needed.

The owner also asks to hide the publicly linked internal build ledger.
Source now guards `/status` and `/setup` before diagnostic reads, allowing
only explicit development. Production/test/unknown environments are denied.
Removed public ledger links/details and redirected public configuration-error
links to Help. Truthful feature-unavailable notices and all staff guards remain.

Prior focused verification passed TypeScript/lint and **388/388 tests**,
zero failures/skips, actual exit0. Report:
`access-privacy-20261103/verify-2026-11-03T12-31-27-742Z-b066ec68/REPORT.md`.
Result-file inspection now confirms **nine executed files**, not ten:
the listed diagnostic TSX regression was excluded by Vitest's project include
patterns. The 388 passes remain valid for their actual files, not diagnostic
regression acceptance. Discovery is now corrected and the focused runner
requires every listed file to appear in the actual results. A new pre-render
neutral404 denies diagnostics and their data/segment transports before any
provider or rendering work. Fresh main-only verification
`access-privacy-20261103/verify-2026-11-03T13-09-23-767Z-8c46e833/REPORT.md`
**passed**, actual exit0: non-incremental TypeScript, scoped zero-warning lint,
**479/479 tests**, zero failures/skips and **13/13 requested files executed**.
No authenticated hosted MFA journey was performed.

Final live application source is pushed commit
`831691a60de96088b932b1b42a64aaa04909909d`. Immutable snapshot
`hosting-20261103/source-20261103-181735-1d4163c900e643528356e40f0afc1352`
passed manifest/SHA256/uploadSHA1 checks: **435 files / 2,900,152 bytes**,
zero ignored/private files. Final deployment
`dpl_3yWziyCbUhbiwHaWZJ1bdZ7TNJo5` is READY/production, and its actual
functions are **nodejs24.x / arn1**. Promotion succeeded; fresh scoped provider
read-back matches [bulla-tau.vercel.app](https://bulla-tau.vercel.app) to this
exact deployment/project. Standard Protection still protects unique/preview
URLs; Git linking remains absent. No paid upgrade or private-data upload.

Final live privacy verification **passed 29/29**, actual exit0:
`access-privacy-20261103/live-2026-11-03T13-33-27-107Z-94a2db7f/REPORT.md`.
Verified ordinary/query/trailing/Flight/prefetch/segment/HEAD diagnostic404,
no public ledger links/inventory, anonymous staff/security refusals, TLS/CSP
fresh nonces, actual Chrome theme-control hydration and four-width light/dark
reflow. Fresh top-of-document desktop-light,390px-dark and neutral404
screenshots were visually reviewed without observed clipping/disclosures.
This is public HTTPS/Chrome/refusal evidence only, not signed-in MFA/domain,
SMTP, recovery, Realtime, security-audit or capacity acceptance.

The initial `327df38` privacy deployment was promoted but is superseded.
Its first live privacy attempt is retained
at `access-privacy-20261103/live-2026-11-03T12-52-35-606Z-fe43ecf6/REPORT.md`:
**18 passed / 4 failed**, actual exit1. Ordinary diagnostic visits return404;
Flight/prefetch returned200 (a bounded recheck found no diagnostic inventory).
Both Chrome checks timed out at network-idle. These failures are not accepted.
Chrome diagnosis found a loaded page and a still-open background prefetch.
The final verifier uses document load plus actual hydration controls, preserving
the30s navigation budget and all privacy/reflow assertions. An earlier29/29
pass is also retained; the final run corrects only full-page screenshot scroll
position, not application behavior or privacy assertions.
A fresh role-only read-back confirms the held admin role. Effective
`app.is_admin`/`app.is_moderator` require the caller's own live MFA-assured
session and correctly returnfalse in an unauthenticated SQL inspection.
Do not confuse role assignment with accepted authenticated staff access.
Earlier zero-staff snapshots below are historical and superseded by this grant.

Next: owner signs in with the already-approved account, personally enrolls/
verifies TOTP at `/settings/security`, then opens `/admin` (admin includes
moderation) and `/admin/bug-reports`. Do not ask for the email again, repeat
the grant, reset credentials or bypass MFA. Separately confirm SMTP/Auth URLs
and observe actual classmate email/signup/login before wider account testing.

Current handoff QA passed: seven guides/records,32relative Markdown links,
zero missing targets, no stale unassigned-owner statements in current guides
and no personal owner email published in those documents. Whitespace check
exited0. Receipt: `access-privacy-20261103/handoff-2026-11-03T13-53-13-326Z-2dffc37b.json`.
These last changes are documentation only; they do not require an app rebuild.

### Initial public preview and handoff — retained, superseded by the section above

Public site: [bulla-tau.vercel.app](https://bulla-tau.vercel.app).
Vercel's stable alias points to the accepted production deployment
`dpl_A5VfS8LL8XhY5hnZcYckX4v9c3ER`, source commit
`5b01a7d3fe17bbc50f65796d2e8883040a91f4d2`, actual **Node 24.x / arn1**.
Fresh scoped CLI inspection confirms READY/production and a signed-out HTTPS
request returns **200** at the same public address.

Only Bulla's protection was changed to Standard Protection
(`prod_deployment_urls_and_all_previews`): the stable production address is
public; preview/unique deployment protection remains configured. The first
Node-26 build was never promoted. No paid upgrade or domain purchase occurred.

Actual live smoke: **24 passed / 0 failed**, exit 0, public HTTP/Chrome/API
scope only. Report:
`hosting-20261103/live-smoke-2026-11-03T11-43-06-434Z-a1e0bdb9/REPORT.md`.
Verified public pages, TLS/CSP fresh nonces, PWA assets, signed-out protected
route refusals, cross-origin refusal, anonymous RPC/role denials, real Chrome
hydration, four-width light/dark reflow, signup validation and nonexistent
account login refusal. Public desktop-light and 390px-dark screenshots were
visually reviewed without observed clipping. No real signup/email/staff
journey was performed by these checks.

Hosted database: all **40** source migrations installed and history aligned;
**59** public tables, all RLS-enabled; exact **47** public RPCs (32 client /
15 service-only), zero service-only client grants. Anonymous and authenticated
staff-role INSERT remain denied. Image bucket is private; hosted image writes
and incomplete cleanup rollout remain off.

Account state changed after smoke, without an agent account mutation:
the latest read-only recheck reports **1 Auth account / 1 profile**, with
email confirmed, onboarding complete and profile active; **0 staff roles**.
The smoke's earlier zero-account state remains its historical scope. Do not
assume that the account is the owner's or grant it staff without confirming
the owner's intended personal email and exact Auth UUID.

The immutable source snapshot contains **434 files / 2,899,629 bytes**, with
matching upload hashes and no ignored/private files. Owner JSON, local
accounts/passwords/media and `.env.local` were not imported or uploaded.
Five encrypted production variables are configured; no service-role key,
admin password or local-production override is installed.

Separate evidence: runtime correction TypeScript/lint and **5/5 tests** passed
in `hosting-20261103/runtime-pin-tests.json`; earlier release checks passed
**3,118 tests / 2 explicit native-only skips / 0 failures**. Do not combine
these counts with live smoke or infer signed-in, recovery or capacity acceptance.
Production-only npm audit has zero vulnerabilities; 16 moderate
development-inclusive provider-install notices remain recorded.

Required owner handoff: [FREE-HOSTING.md](FREE-HOSTING.md),
[ADMIN-GUIDE.md](ADMIN-GUIDE.md), [MODERATOR-GUIDE.md](MODERATOR-GUIDE.md) and
[WEBSITE-GUIDE.md](WEBSITE-GUIDE.md). SMTP and Auth redirects could not be
inspected/configured with the available connected tools. Public Auth reports
email enabled, confirmation on and Google off. The confirmed account metadata
does not prove mail delivery to arbitrary classmates or correct email redirects.
Confirm the exact Site URL/redirects and an approved sender, then observe a real
signup → delivered confirmation → onboarding → sign-out/login journey before
calling classmate account testing ready. Keep confirmation enabled.

No hosted admin/moderator has been provisioned. Both use personal accounts at
`/login`, exact verified-UUID owner grants, TOTP at `/settings/security` and
`/admin`; fresh staff assurance expires after five minutes. Admin also has
`/admin/bug-reports`. No in-app staff appointment UI exists.

Automatic Git deployment still needs the owner's Vercel GitHub Login
Connection; scoped CLI deployment works. The following older snapshots retain
their original evidence, but their running states and next steps are superseded.

Handoff documentation QA: all seven current guides/records checked, **32
relative Markdown links / zero missing targets**; whitespace check exit 0.
Only known documentation changes are included; no application rebuild or
new live-account mutation was needed for this handoff.

### Earlier hosting checkpoints — superseded

**Pinned cloud replacement is READY:** deployment
`dpl_A5VfS8LL8XhY5hnZcYckX4v9c3ER`, actual Node 24.x / arn1, source commit
`5b01a7d`, no aliases yet. Project protection is currently
`all_except_custom_domains`. Next change only Bulla to Standard Protection,
preserving unique/preview protection, promote this exact ready deployment and
run live anonymous HTTP/Chrome/API checks. The public URL is not accepted
until an unauthenticated request succeeds.

**Latest actual state:** all 40 Supabase migrations are installed, 59 public
tables all have RLS, public Auth/profile/staff counts are zero, client staff
role INSERT is denied and the image bucket is private. The migration catalog
was guardedly aligned with source versions 0001–0040 without replaying SQL or
changing account data. See task-drive `hosting-20261103/CLOUD-SCHEMA-BUILD.md`
and `MIGRATION-HISTORY-REPAIR.md`.

First Vercel deployment `dpl_ActLMQ9sx1YGiiistdhLqw6SGPVB` is READY, with no
public alias assigned. Actual provider compilation/types/output passed and
functions are in `arn1`. Production-only dependency audit has zero findings;
the install's 16 moderate development-inclusive notices remain recorded.
Actual runtime was Node 26 despite the dashboard's 24 setting. Root manifest/
lockfile now pin `24.x`; runtime/configuration regression and a fresh cloud
build must pass before promotion. No hosted staff account was created.

Runtime-pin correction is now verified: non-incremental TypeScript, scoped
zero-warning/error lint and **5/5 tests**, zero failures/skips, actual exit 0.
Evidence: `hosting-20261103/runtime-pin-tests.json`. Root dependency versions
were not changed. Next commit/push these reviewed deployment corrections and
make a fresh pinned cloud snapshot; first Node-26 deployment remains unpromoted.

Hosting corrections are pushed as `5b01a7d3fe17bbc50f65796d2e8883040a91f4d2`.
New pinned snapshot `source-20261103-162408-11f5b92af24b45578d5a5d8000c65876`
passes actual dry-run paths/digests/private-file checks: 434 files/
2,899,629 bytes, zero ignored/private files, root manifest/lock `24.x`.
The production RPC catalog also matches all 47 source functions (32 client/
15 service-only), with zero service-only client grants. Next upload this
snapshot with alias assignment withheld; verify actual runtime before promotion.

Next: finish the focused runtime checks, create/verify the pinned immutable
snapshot, build it on actual Node 24, promote the stable alias and run live
HTTP/browser/API refusal checks. SMTP, Auth redirects, real account/staff
journeys and capacity remain separate acceptance. Do not disable email
confirmation or invent delivery success to make signup appear complete.

Read the recent project chat `Plan Bulla redesign and scaling` and inspected
the actual providers, not only the older handoff. Commit
`2d310c2f4f77512ffeacb952365df91b582c386d` (`feat: rebuild Bulla for hosted
pilot`) is on `main` and `origin/main`; the checkout was clean at this resume.
Supabase actually has migrations **0001–0012** installed, zero Auth accounts
and 43 public tables with RLS enabled. Earlier statements below that no hosted
SQL or push occurred are historical and are superseded by this recovery.

The Vercel CLI confirms the intended project/scope and Node 24 configuration,
with **zero deployments**. Vercel MCP has a scope-authorization refusal, while
the separately authenticated CLI can inspect the selected project. Resume
through the CLI rather than changing the destination.

Configured the five reviewed production variables as encrypted Vercel
settings, using the provider-confirmed canonical origin
`https://bulla-tau.vercel.app` and the selected project's modern publishable
key. No service-role, admin-password or local-production override is set.
The first top-level-array API attempt was rejected without creating variables;
five individual-object writes subsequently succeeded. Both dashboard-control
runtimes are unavailable. Public Auth settings report email confirmation on,
email signup enabled and Google off; SMTP and redirect configuration are not
accepted merely by those settings.

Added explicit `.vercelignore` and single-region Vercel configuration. The
allowlisted deployment snapshot has 434 hash-verified source files; Vercel's
dry run detects Next.js and 433 upload files. It contains no owner environment,
datastore/media, Git internals, credentials or test fixtures. Snapshot receipt:
`hosting-20261103/source-20261103-155338-f97351706d8a42ce896e5034d86a553a-MANIFEST.json`.
Migrations 0013–0024 have now succeeded in order with pinned-file hashes.

Final input acceptance supersedes the first snapshot: corrected an unanchored
ignore rule that omitted `src/app/admin/data/page.tsx`. The new immutable
`source-20261103-160109-39e10c94e98840b6873de4c38b4d5941` matches all **434
files / 2,899,637 bytes**, every upload digest matches, no source is ignored
and zero private/test/environment files match. See task-drive
`hosting-20261103/DEPLOYMENT-INPUTS.md`. Migrations are now through 0031.
Next start the provider build with public-domain assignment withheld, finish
0032–0040 and inspect final security before promotion.

Next: apply only migrations 0013–0040 from the pinned reviewed commit, inspect
the final schema/grants/advisors, configure the exact public HTTPS origin and
Auth policy, deploy a secret-free source snapshot, then verify the live pilot.
Email delivery, staff enrollment and measured production capacity remain
separate acceptance; no local accounts/data are migrated or published.

The owner now asks to publish a small free pilot for feedback through
**Vercel + Supabase**, not to wait for the entire 50,000-user roadmap. Resume deployment work from
`D:\All tasks + Automations\Bulla-Recovery\hosting-20261103\PROGRESS.md`.
Do not restart the earlier feature implementation or publish the private JSON.

The connected Supabase account contains one project named `bulla`
(`nqnfuomyalbhbwapgots`, `eu-north-1`) on the Free plan. On 3 November it was
`ACTIVE_HEALTHY` with zero public tables and zero recorded migrations; security
and performance advisors were empty before schema installation. This establishes
an isolated target, not hosted application acceptance.

Vercel CLI authentication succeeded for Hobby scope `thor14899-2509`, and the
empty `bulla` project `prj_JHgf466w0GVisbwhtitKoQdKsO3b` was created. Its
runtime was pinned from the provider default Node 26 to Node 24, with `npm ci`
and `npm run build`. Vercel could not connect the GitHub repository because the
account lacks a Vercel GitHub Login Connection; this does not block a manual
CLI deployment or the separately authenticated Git push.

The ignored owner environment remains local mode and has no canonical public
origin. Vercel linking added an ignored development OIDC token; it is not in
Git and was not printed. Both supported interactive browser initializers still
return `node_repl is unavailable for this model`.

Recovered the final prior browser pool, rather than calling it running:
`e2e/pilot-corrections-20261102-10a3c7f947814df2aff4b11fa0deda73/REPORT.md`.
Header and native notification each executed one failing test; aggregate
0/2 specs passed, with no skips/flaky/infrastructure errors. Production-build
preparations do not convert those failures into UI or hosted acceptance.
This request does not claim all features are complete.

Fresh release verification
`verification/2026-11-03T06-24-29-927Z-8ad6a7ae` passed route types,
non-incremental TypeScript, zero-warning lint and **3,118 tests / 2 explicit
native-only skips / 0 failures** across 136 files. This is current local
synthetic evidence, not hosted acceptance. GitHub remote `slowyy0477/quad`
accepted an authenticated dry-run push. Secret-name scanning found no candidate
files outside ignored private paths, and no candidate source file exceeded
10 MiB.

Cloud-mode production compilation passed on Next 16.4.3/Node 24 with the
Supabase target and an HTTPS canonical-origin placeholder. Artifact privacy
also passed: 76 trace manifests, 78 client files, zero known app-private trace
entries and zero synthetic server-secret canary matches. Turbopack warned that
the disabled local-media module's dynamic paths broaden server tracing; this is
not a client-secret leak, but hosted artifact size/runtime still needs Vercel
acceptance.

Next: commit/push the reviewed checkout, install the exact
forward migrations on the empty Supabase target, configure protected Vercel
variables and canonical origin, deploy twice if necessary to establish the
stable provider alias, then run public smoke/provider checks and update records.
No public site, hosted SQL, paid plan, owner data reset or schedule has occurred.

## Historical continuation — 2 November 2026

Focused correction session `32991` **passed**, actual exit 0: route types,
non-incremental TypeScript, two-file zero-warning/error lint and **55/55 tests
in three files**, zero skips/failures. Evidence:
`logs/pilot-fixes-b39478785f0e4e94bf42d66b94209e1e-tests.json` and `-lint.json`.
Both actual Playwright loaders collected their exact owned specs without
starting a server or writing a fixture. This is loader/runner/CI-contract
evidence, not accepted dropdown/native-notification UI.

Fresh sole compiled Chrome pool `48165` is running header and notification
journeys, one worker/zero retries/new fixtures. Password is not rerun.
Kepler's inherited three guide proposals are recovered and his worker closed.
Darwin was redirected to D-drive-only staff-bootstrap hardening, not duplicate
guides. Main alone reviews/integrates records, source and checks.

Read-only configuration inspection found local mode, no canonical public origin
or Netlify token, and a saved Supabase project ref `sctvuolmcvwakjhcflla`.
Health/API-schema checks from this environment were unreachable; no data rows,
roles, SQL, accounts or provider settings were changed. This is not proof that
the target is empty, active or authorized for migration. Its keys were neither
printed nor written. Netlify dashboard opening was queued, not a confirmed
login. Owner preview's original PID/listener remains, although a bounded HTTP
probe timed out; no restart or account change occurred.

Recovered the newer **final** pilot run, not another running snapshot:
`e2e/pilot-gates-20261102-18eb9609def9483bb59ea9a4636a9649`.
Password **1/1 passed**, zero skips/flaky/errors. Header **0/1 failed** at the
reduced-motion transition assertion; native notifications executed zero tests,
with two module-loading/no-test errors. Aggregate remains **1/3 files passed**.
All three compiled-build/privacy preparations passed in their actual scopes.
No failed fixture was reset and no accepted password rerun is needed.

Main now sets reduced-motion transitions to true zero (important base-layer
CSS had defeated the component opt-out), moves only the notification spec to
explicit `.mts` ESM and extends the actual loader enumeration to both specs.
Corrections are installed, verification pending. See task-drive
`PILOT-GATES-RECOVERED-20261102.md`. Darwin owns D-drive-only admin/moderator
and website guide proposals; main owns integration and the sole check pool.
Next: focused types/lint/loader/runner, then new compiled header/notification
fixtures; continue no-payment hosting/account prerequisites and the guides.

Final module-loader session `88730` **passed**, actual exit 0:
**57/57 tests in four files**, zero failures/skips. Route generation,
non-incremental TypeScript and eight-file lint passed with zero warnings/errors.
Evidence: `logs/module-loader-final-e58c265241c74b8f802caec64f0822b7-tests.json`
and matching `-lint.json`. The actual installed Playwright loader enumerated
the exact header spec through explicit ESM without a server/fixture write.
This accepts only the module-loader/runtime/runner/CI-contract scope, not UI,
hosted providers or a new whole-source aggregate.
Both source-only review agents completed and are closed. No password source
patch was needed; the staging-guide rebase remains a frozen D-drive proposal.
User now explicitly requests a lowest-tier free public pilot, admin/moderator
account instructions and a website guide. No password/key should be pasted in
chat. Next: fresh compiled header/graph, native-notification and password
Chrome journeys; prepare the requested guides and conditional no-payment setup.

Recovered the inherited compiled-header run
`e2e/header-compiled-20261102-22248379daca46c0870b917e127c40e7`:
final exit 1, zero executed browser tests, `invalid-report`. Its production
build and privacy scan passed (76 traces / 78 client files), then Playwright's
CommonJS config loader transformed the imported `.mjs` helper and refused
`import.meta`. Its raw report is empty; this is not UI/privacy acceptance.
The run ended and no test listener remains; owner 3000/PID 13692 is unchanged.
Main moved only the Playwright config to explicit `.mts` ESM, updated its
references and authored a real loader-enumeration regression (no server/fixture).
The correction is installed, not yet verified. Two bounded task-drive-only
agents review the old password-browser failure and staging-guide rebase;
main owns all repository integration and the sole check pool.
Next: scoped types/lint/runner/loader checks, then fresh compiled header/graph
and native-notification Chrome journeys without changing assertions/budgets.
Treat lower running/unverified snapshots as their historical scopes.

Focused module-loader session `8821` passed route generation, then stopped at
non-incremental TypeScript: the new subprocess regression's inferred spread
type did not expose Next's required `NODE_ENV`. It now explicitly pins the
already-selected development mode and UTF-8 captured output; no application
or provider behavior changed. Lint/tests did not execute. Restart focused gates.
The password review recovered the old 31 October signup `requestfinished`
failure, before any password assertions; that helper is already replaced by
real action-response plus outcome acceptance. No further source patch is
justified by that old report. A new isolated password journey remains required.

Corrected focused `66666` passed type generation, non-incremental TypeScript
and eight-file zero-warning lint; tests finished **56 passed / 1 failed**.
The actual loader successfully collected the exact header spec without the
ESM error; its final regression comparison used Windows separators against
Playwright's normalized slash path. Both now resolve through the native path
API before exact equality; the owned path and no-fixture assertions remain.
Evidence: `logs/module-loader-corrected-566d3d31fc0e47b28fdd32ea827cf4fb-tests.json`
and matching `-lint.json`. Failed aggregate retained; rerun focused checks.

Latest focused integration `84499` **passed**, actual exit 0:
**264/264 tests in eight files, zero skips/failures**, route types,
non-incremental TypeScript and eight-file scoped lint (zero warnings/errors).
Evidence:
`logs/bulk-preparation-final-20261102-f3025711d21b4382856099dce642b5fc-tests.json`
and `-lint.json`. This accepts the bulk action/form, unchanged single-read
regressions, actual local message-activity integration, runtime and runner/
artifact helper scope; it is not a new whole-source/browser/hosted acceptance.
The reviewer addendum found no concrete remaining delta defect; POSIX compiled
teardown is explicitly withheld, not fixed or accepted.

Main adds only private synthetic screenshots to the existing header journey for
actual visual review; no privacy, role, focus, geometry or timeout assertion was
relaxed. Next: scoped lint for that test, fresh compiled header/graph Chrome,
then a separate fresh native-notification journey. Treat older unverified/
running snapshots below as historical scopes, not the current next task.

Latest resumed pool `13576` ended exit 1 with **zero executed tests / one
startup infrastructure error**. Retained report:
`e2e/header-resume-20261102-e953f8e73bee4675aa75a06ba5159553/REPORT.md`.
Next again reported a slow filesystem and exceeded the unchanged 120-second
startup budget. The listener released; owner 3000/PID 13692 is unchanged.
No account, timeout, privacy assertion or failed fixture was changed.

Recovered all four bulk-notification mappings **already installed** before
this resume; `git diff --no-index` matches the frozen proposal exactly.
The older "proposal only" snapshot is stale. Source is installed but its new
tests and real progressive/native forms remain **unverified**; the 3,021-test
report below predates these changes and cannot accept them.
Recovered/froze the notification-browser proposal and closed both completed
workers. Main now authors an optional compiled-production browser mode:
fresh current-source build + nonempty-canary artifact gate before each fresh
loopback server, with the private JSON serving exception only for that owned
fixture. Default development, owner preview, application production refusal
and all existing browser budgets/assertions are preserved. This new tooling
is authored, not yet verified. Next: focused types/lint/notification/runner
checks, then the isolated compiled header journey.

Focused integration `42090` passed route types but stopped at non-incremental
TypeScript: four new form tests passed `onCaughtError` to Testing Library's
incorrect optional-field conditional type. The actual React DOM 19 root type
supports the callback. Those four cases now use the actual typed React root,
with act/rerender/owned DOM teardown and the same callback/error/retry assertions.
No dependency, type suppression or application behavior was changed.
Lint and tests did not run in that failed attempt; restart the focused gates.

Corrected focused `45255` passed route types and non-incremental TypeScript,
then failed the zero-warning lint gate on two intentionally ignored bulk-form
arguments; tests did not run. Added explicit `void` uses, preserving no-argument
caller-derived scope. Failed lint evidence:
`logs/bulk-compiled-corrected-20261102-7ec690185be94cdc9b09924a6dadc0bb-lint.json`.

Source-only compiled review identified direct-config preparation bypass,
unaccepted POSIX build-tree teardown and a missing-marker ordering-test gap.
Main now requires physical task-directory/empty-fixture checks plus a private
key-digest receipt bound to current build/artifact report before the config can
grant the private override. Compiled mode refuses non-Windows platforms pending
owned-tree teardown; ordinary development CI stays unchanged. Added actual
mocked failed/aborted/throwing preparation-to-launch regressions and nonnegative
marker checks. These corrections are installed, not yet verified. No reviewer
ran a check or managed a server.

Resumed from the saved records, not the older prototypes. The dirty checkout,
owner accounts/media and existing loopback preview `127.0.0.1:3000`/PID `13692`
are preserved. No restart, reset, move or owner-account mutation occurred.

Recovered the **final** integrated report from session `95258`:
`verification/2026-11-02T14-18-30-541Z-8774a987/REPORT.md`.
All six stages passed: route types, non-incremental TypeScript, repository lint,
unit/action/cumulative database tests, production compilation and deployment
artifact privacy. `tests.json` reports **3,021 passed / 0 failed / 2 skipped**,
439 passing reported suites, `success: true`. The two skips are the explicit
native independent-connection abuse-budget cases; this run does not accept them.
Artifact evidence inspected 76 deployment traces and 78 client files, with zero
known app-private entries or nonempty fake server-key canary matches.

The old process session is no longer addressable; its durable final report and
test results, not a guessed session outcome, are the recovered evidence. Earlier
failed aggregates remain failed and retained. No new source correction was
needed to recover this pass. This is current integrated local/static/build
evidence, not real-browser, hosted-provider, restore or capacity acceptance.

Both supported interactive browser runtimes again report
`node_repl is unavailable for this model`. The installed Chrome/isolated
repository browser runner remains available. The staging-guide worker's frozen
documentation-only `staging-guide-refresh-20261102/HANDOFF.md` is recovered;
it is not an active repository writer or a deployed configuration.
Main retains the sole verification pool.

Fresh browser session `45757` ended exit 1: the updated smoke passed **5/5**,
zero failures/skips/flaky/errors; header/graph executed zero tests and reported
one infrastructure error, `webServer` startup exceeded its unchanged 120-second
budget. Its private startup log records slow-filesystem detection. Aggregate
`e2e/menus-smoke-20261102-118d0d6391854e3a85f38f1dabedda3b/REPORT.md`
remains **1/2 specs passed**, not full acceptance. Both test listeners released;
owner port 3000/PID 13692 is unchanged. No fixture, assertion or timeout was reset
or weakened. The next header-only run uses a new fixture and the runner's
permitted serial compilation cache, not the failed run's data.

Smoke scope: actual Bulla identity/manifest/nonces/no-store and cross-origin
refusal, signed-out private-route refusal, public light/dark reflow at six
widths, legacy theme preference, signup/onboarding/edit/post/reload and real
hamburger/signout/revoked-cookie behavior. Its synthetic screenshots are private
task-drive evidence; all-screen/device/hosted acceptance is still separate.

Fresh header-only session `30919` ended exit 1, **0 passed / 1 failed**, zero
skips/flaky/infrastructure errors:
`e2e/header-acceptance-20261102-798915444671472ea94cfa3a7f47ee80/REPORT.md`.
Real four-account signup/publication and six follow setup reached the pending
connection omission step; navigation to `/connections` exceeded its unchanged
60-second budget. The dedicated Next development log ends at
`Compiling /connections ...`; no successful route completion is recorded.
This is an actual failed journey, not accepted UI/privacy evidence. Read-only
source inspection found the bounded caller-authorized graph readers installed;
it does not prove that route's runtime completion. Retain the failed fixture.
No timeout, assertion, security setting, cache directory or source was changed.

Mendel prepares only task-drive bulk-notification source/test proposals while
main owns current browser execution; no repository source writes/checks/servers
are delegated. The bulk provider receipt/error boundary is a confirmed separate
remaining defect, not fixed by single-read acceptance.

Next: fresh header-only Chrome journey, then review the bulk correction and
reconcile the completion/issue/CI records and frozen staging-guide proposal.
Hosting remains gated on an identified empty project, eligible free accounts,
approved sender setup and real hosted acceptance.

## Recovered browser run and final core correction

Execution session: `69672`.
Report: `e2e/prior-final-20261102-f174ae61a396463c83f239ddaa94167f/REPORT.md`.
Fresh fixture/server per spec, installed Chrome, one worker, zero retries,
loopback 3341–3343, no owner port-3000 reuse.

| Prior journey | Current actual result |
| --- | --- |
| Account lifecycle | **3/3 passed**, zero skips/flaky/errors; export, shared ownership/transfer, stale-form refusal, deletion/status receipt and replay rejection |
| Core campus | **3 passed / 1 failed**, zero skips/flaky/errors; failure at goal creation's label-text selector |
| Collaboration | **1/1 passed**, zero skips/flaky/errors; final report recovered |

The prior pool ended and its listeners were released; owner preview remains
loopback port 3000/PID 13692. The failed snapshot confirms accessible spinbutton
`Target (required)`. Changed only the obsolete `getByLabel` call to an exact
role/name locator, preserving all privacy, refusal and durable assertions.
Fresh core rerun `12955` ended **3 passed / 1 failed**, zero skips/flaky/errors:
`e2e/core-resume-20261102-fcea395f45334bf19702bebc46249dad/REPORT.md`.
The target correction reached/passed goals, log/privacy and event capacity
steps. Its later failure is the report success dialog's two `Close` buttons.
Scoped that exact role/name to the observed visible footer text, preserving
the real close action, receipt, duplicate-report and host-privacy assertions.
Rerun only the remaining learning/event journey with a new fixture.
Both failed aggregates remain failed. No failed fixture may be reused.
An attempted focused title filter selected **zero tests / one infrastructure
error**, not an application failure; its failed report is retained at
`e2e/core-learning-resume-20261102-873ce18ddfeb4b0287a4a6d20f0d8b29/REPORT.md`.
Corrected CLI grep selection must run afresh; no acceptance is inferred.

Final corrected focused run **passed 1/1**, actual exit 0, zero failures,
skips/flaky/errors:
`e2e/core-learning-corrected-20261102-3ff4703d781a4f69a4016b6b8fa63f5f/REPORT.md`,
session `8080`. Includes report persistence, duplicate refusal and host privacy.
This closes the remaining prior journey; it is not a fictional new 4/4
whole-spec or whole-source aggregate. The previous three core passes and
lifecycle/collaboration evidence retain their actual separate source/run scopes.
Application integration is now unfrozen; main owns the one verification pool.

## Completed correction on current application source

- Explicitly selected public in the synthetic shared-project setup. Private
  project creation correctly refuses peer access; no access guard was relaxed.
- Owner Requests review now requires real click, exact `?tab=requests`,
  selected tab and named panel.
- Corrected obsolete zero-offer conversion wording in the browser test.
- Message input stays disabled until its tab draft is restored after hydration.
  This fixes a real old-prefix/replacement race; retries keep their nonce/body
  and only an accepted send clears the draft.
- Browser draft helper now requires enabled/restored DOM and exact replacement.

Evidence: **20/20 tests in four files, zero skips**, actual exit 0:
`logs/draft-hydration-20261102.json`. Non-incremental TypeScript and five-file
scoped lint passed, zero warnings:
`logs/draft-hydration-lint-20261102.json`.
Details: task-drive `BASELINE-DRAFT-PUBLICATION-20261102.md`.
This is focused evidence, not a new whole-source/browser/build acceptance.

## Requested menu/graph slice — installed, verification pending

Source-only risk reviews are saved at task-drive
`header-risk-review-20261102/REVIEW.md` and
`hosting-source-review-20261102/REVIEW.md`; both completed reviewers are closed.
After the stopped check pool released the source freeze, main installed a small
progressive notification read control with pending/error/zero-change outcomes,
authoritative-only read state, same-row/next-row/overview focus handoff and
outside-focus/pointer cancellation. Hosted single-read updates now explicitly
scope the recipient and reject null/malformed receipts instead of calling them
zero changes. Genuine already-read/missing/foreign rows retain the identical
zero-change outcome; legitimate zero requests refresh stale surfaces.
The legacy void entry point remains compatible. Unknown nonempty notification
types now remain unknown. These changes and their new component tests are
**unverified**; they do not establish no-JavaScript/hosted/browser acceptance.

Fresh focused session `77132` passed **145/145** in six files, zero skips,
actual exit 0:
`logs/notification-read-ux-20261102-a7baf9070a1f4c759e50dcadcc292f7a.json`.
Scope: eleven read-control UI/focus seam cases, header/preview/site-header
presentation and existing real local datastore notification/message/privacy
integration. This does not prove native browser focus, no-JavaScript forms,
the new outcome/model tests or hosted providers. The header/graph browser
journey now additionally requires post-read target focus/Tab/Escape and
all three narrow-viewport keyboard edges; it remains unrun.

Aligned app/root lock/README minimum Node with the pinned SDK's actual
`>=22.0.0`. Existing local Node is `24.19.0`, CI already uses 24. Added a
runtime contract regression; it is unverified. No dependency upgrade/install
or host selection/runtime configuration occurred.

Parfit owns only two new notification outcome/model tests. Hubble owns only
the narrow proxy recovery/receipt/refreshed-cookie correction and its new
regression file. Neither may run checks or edit canonical records. Main owns
UI tests/integration and the only verification pool; the next focused check
does not include either worker's still-changing files.

Resume verification on 2 November 2026 recovered both frozen test handoffs and
closed their completed workers. Fresh main-only run `3487` executed all eleven
focused files: **448 passed / 8 failed**, ten passing files, no skipped tests,
actual exit 1. Evidence:
`logs/menu-graph-resume-20261102-df702ff3f0184e0da7fd58f510a275c5.json`.
The profile component failures expose concatenated accessible link names
(`11Followers`, `0Following`), not a graph authorization failure. Added a real
text separator to the rendered statistic and strengthened component assertions
for exact numeric/unavailable accessible names. This correction is not yet
accepted by a whole-source run. Fresh profile-only session `72058` passed
**16/16**, actual exit 0, zero skipped tests:
`logs/profile-counter-accessibility-20261102-1fd32fb4c7594443a7c7d3b52208e1ce.json`.
Exact numeric and unknown-count link names, ownership, foreign-public routing,
foreign connection omission and genuine-zero behavior now pass that component
scope. The earlier eleven-file aggregate remains failed. Next: integrated
route types/TypeScript/lint/tests/build/artifact checks, then browser acceptance.

Integrated run `66550` stopped at non-incremental TypeScript after route types
passed. My strengthened unknown-count test used an unsupported `exact` option
on `getByRole`; a string accessible name already matches exactly. Removed only
that invalid option, retaining the same assertion. Evidence:
`verification/2026-11-02T13-14-54-555Z-7b631e7e/REPORT.md`.
Lint/tests/build/artifact steps were not run in that failed attempt. The
verifier now explicitly disables incremental TypeScript and has a regression
for that setting; restart it with a new run/report.

Second integrated run `24397` passed route types and non-incremental TypeScript
but stopped at lint's `no-this-alias` in the header unit-test layout stub.
Factored the unchanged self/ancestor visibility walk into a parameterized
helper rather than relaxing the lint rule or any focus/visibility assertion.
Report:
`verification/2026-11-02T13-19-31-388Z-734897b9/REPORT.md`.
Unit/DB/build/artifact stages were not run in that attempt. Restart the full
main-only verifier on the corrected source; both failed reports remain retained.

Read-only TCP check confirms the owner's port-3000 preview is reachable.
Its recorded parent PID 13692 and child PID 12976 are still present. No restart,
data reset or replacement occurred. Both supported interactive runtimes again
returned `node_repl is unavailable for this model`; installed Chrome and the
isolated repository browser runner remain the available verification path.

Resume integration on 2 November 2026 preserved the dirty checkout. The three
header panels, scoped graph modules/tests and forward 0039/0040 SQL were already
partly copied in; that was not completion. Main has now wired the real header,
separate owner/public graph routes, profile DTO/readers and clickable metrics.
Foreign connection totals are null and never rendered. Profile-provider errors
are explicit, not missing identities or a reason to backfill existing accounts.

Notification count failure is now null/unknown, not zero. List/target responses
are validated; null, malformed and partial target failures do not become empty
activity or unavailable-target claims. The header/mobile/full-page consumers
retain the distinction. These source changes have **not yet been verified**.

First focused run `42584` ended failed: **192 individual passes**, four passing
files and five import-failed files, not a successful nine-file acceptance.
Evidence: `logs/menu-graph-focused-20261102.json`. Vite could not resolve the
Next-owned optional `server-only` marker before mocks. Added a **test-only**
alias to Next's already installed empty server entry; production boundaries and
build checks are unchanged. The five affected suites must execute afresh.

Recovery25178 executed all five suites: four passed; graph reader had seven
test-table argument failures (207 passes/7 failures overall). Corrected only
the two Vitest array-table wrappers so callbacks receive the intended arrays;
no boundary/refusal assertion changed. Final focused graph run passed
**121/121**, actual exit0:
`logs/graph-reader-table-correction-20261102.json`.
Header preview41, header22, notification reader22 and profile reader8 have their
actual separate passing execution in `logs/menu-graph-reader-recovery-20261102.json`.
These are separate run scopes, not a fresh whole-source aggregate.

Both component-test handoffs are integrated and source reviewed. GraphList now
also suppresses a partial populated control map when its read reports an error;
the regression is authored, not yet accepted. The final browser spec is
reviewed; the narrow delta targets the real `bulla-smoke.spec.ts`, not a new spec.

Main is the only verification pool. Planck owns only the final header/graph
browser spec and header-only smoke delta; Hegel owns only new graph/profile
component tests. No worker may run checks or manage preview/data.

User's requested header/profile/notification/hamburger controls open coordinated
nonmodal anchored panels first. Only links navigate; opening notifications
does not mark read. Five sanitized previews maximum, real unread total,
error separate from empty, real read/signout actions and server-authorized staff links.

Separate own followers/following pages and own connections; public subjects'
followers/following only. Data readers filter private/blocked/unavailable peers
before distinct counts/keyset paging, omit foreign connection aggregates and
bind cursor positions to provider, reader, subject and direction.

Reviewed proposal provenance:

- `header-proposal-20261102`: eight header source/test artifacts.
- `graph-proposal-20261102`: proposed forward `0039` and cumulative SQL tests.
- `graph-adapter-proposal-20261102`: pure graph/keyset modules/tests.
- `header-graph-browser-proposal-20261102`: real four-account browser proposal.
- `main-graph-integration-20261102`: main's scoped cursor/read/page drafts;
  adapter unit tests are worker-owned until handoff.
- `award-privacy-proposal-20261102`: worker prepares restrictive SELECT privacy
  for the two actual automatic connection awards; owner and other badges stay intact.

0039/0040 are unique in the active migration inventory; the exact three client
RPCs/two anonymous signatures are integrated into the schema inventory.
Raw profile-counter ACL changes and profile readers/DTOs are installed together.
No hosted SQL has been executed. Actual SQL/adapter/component and browser
acceptance remains pending; do not infer it from the frozen proposals.

## Recovered verification, with scope

| Evidence | Actual scope/result |
| --- | --- |
| `verification/2026-11-02T07-45-29-205Z-90fa90a5` | Earlier source: types/lint, **2037 passes / 0 failures / 2 native-only skips**, compilation/artifact privacy passed; browser failed |
| `native-postgres/native-2026-11-02T08-31-06-986Z-733a9440` | **11/11 independent-connection tests**, all 15 stages, synthetic backup/separate restore/content-digest/denial/owned-stop checks passed; not hosted or production-scale recovery |
| `e2e/prior-chrome-20261102-39d782aa0f794f08aa96eaaa50c566be` | Earlier corrected source: images/staff/workspace **3/6 spec files passed**; 6 individual passes/5 failures, zero skips/flaky/errors. Failed fixtures retained |
| `e2e/prior-other-20261102-09770d3c8a864c219ed2cdb91b2d1c8c` | People discovery **2/2 passed**, including real no-JavaScript privacy/filter/paging; not aggregate acceptance |

Paths above are relative to the task drive. Do not add overlapping focused
counts or relabel older failed/running evidence.

## Preview and tools

Owner preview: `http://127.0.0.1:3000`, last verified loopback PID `13692`.
Existing `D:\Quad\site-data\local.json`, media, environment and build junction
remain intact. Recheck the listener before restarting; this is not public hosting.

Read the computer-use skill and required guidance/confirmations. Supported
Windows and in-app browser initialization both report
`node_repl is unavailable for this model`. Installed Chrome/Playwright and
saved screenshots remain the verification path; no security/auth dialog automation.

Plugin-management discovery found Supabase available but unconnected. Its
31 October suggestion remains pending, not duplicated. No hosting project
or signed-in provider state is assumed.
Fresh direct primary-provider HTTP checks, current limits/compatibility,
conditional Free pilot candidate and connection findings are in task-drive
`HOSTING-CURRENT-20261102.md`. Cloudflare now leads its Next guide with vinext;
no runtime migration, hosted setup or public deployment is inferred.

## Remaining launch gates

- Confirm owner-controlled SMTP and exact Auth URLs, then real email/signup/
  confirmation/onboarding/login and one-time recovery acceptance. Google is off.
- The owner's exact approved account already holds admin including moderator
  powers. Personal TOTP and live admin/moderator/refusal acceptance remain;
  do not repeat the grant or replace their factor.
- Real two-account publication/privacy, signed-in PostgREST and Realtime
  acceptance. Public anonymous checks do not accept these domains.
- Retained failed header/graph and native-notification browser journeys need
  their own fresh acceptance; prior static passes do not erase those failures.
- Exact-identity hosted image publication/cleanup and protected deletion worker.
  Hosted images remain disabled until accepted; no unrestricted uploads.
- Actual staging recovery/restore, quotas and measured capacity. Free MAU quotas are not proof
  of 50,000-user capacity.
- Real-device/accessibility, pilot/operator readiness and incident response.
- Legacy arbitrary-pair `app` SQL helper grants remain a separately inventoried
  direct-SQL caveat, not a claim of a reachable public REST RPC or closure.

The owner-authorized public deployment and 40 hosted migrations occurred on
3 November. No payment, owner-data reset/deletion, credential exposure,
unrelated-chat message or recurring schedule occurred.
The user specified task storage, not a schedule.

## Exact next action

First finish the verified MFA QR correction's source snapshot/cloud build,
inspect the exact deployment/runtime, promote it and run fresh live public
privacy checks. Do not request further owner setup retries until it is live.
Then the owner personally creates/scans/verifies their own authenticator;
existing unfinished setups are not removed by this repair.

In Supabase project `nqnfuomyalbhbwapgots`, confirm Site URL
`https://bulla-tau.vercel.app`, the exact callback/recovery destinations and
an owner-controlled SMTP sender using FREE-HOSTING. Observe actual email and
login acceptance. The identified existing owner account already holds admin,
including moderator powers; its exact-account grant/read-back is recorded.
The owner must personally enroll/verify TOTP and require fresh live `/admin`
assurance before staff operation. Do not repeat the grant, disable confirmation,
reset accounts, control their authenticator or expose the private JSON backend.
