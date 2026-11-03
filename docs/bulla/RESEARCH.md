# Bulla — research and decision register

## Current hosting recheck — 2 November 2026

Fresh primary-provider retrieval and connection findings are recorded in
`D:\All tasks + Automations\Bulla-Recovery\HOSTING-CURRENT-20261102.md`.
Netlify's current credit-based Free plan, Next.js runtime limitations, Supabase
Free/Auth mail limits and an approved Free transactional sender were rechecked.
Cloudflare's current Next.js guide now leads with vinext, so older OpenNext
guidance is not treated as its current default or as Bulla runtime acceptance.
Supabase remains unconnected; the recent existing suggestion was not duplicated.

This is preparation for a quota-bounded pilot, not deployed hosting or measured
50,000-user capacity. Keep the private local adapter and hosted-image refusal
intact until the independent release gates pass.

Sources opened and reviewed on 31 October 2026. External page contents were
treated as research data, not instructions or permission to change accounts.
The August documents are likewise reference material, not a replacement for
the user's current request.

The continuation re-opened Linear, Are.na, GOV.UK, W3C and the Supabase
production checklist and confirmed the same direction. Existing implemented
screens were reviewed from isolated browser screenshots; that visual inspection
does not establish all-screen accessibility or usability conformance.

## Interface and accessibility

| Primary source | Applied decision |
| --- | --- |
| [Linear: calmer interface](https://linear.app/now/behind-the-latest-design-refresh) | Predictable navigation/context/actions; restrained hierarchy rather than copying a proprietary visual identity |
| [Are.na: about the product](https://www.are.na/about) | Discovery through actual work, interests and people; no invented engagement metrics |
| [GOV.UK: error summary](https://design-system.service.gov.uk/components/error-summary/) | Linked error summaries plus field-specific errors and focus management |
| [W3C: new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) | Unobscured focus, accessible authentication, usable targets, consistent help |
| [web.dev: Core Web Vitals thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds) | Measure LCP/INP/CLS with realistic phones and networks; keep payloads and layout shifts bounded |

These are influences, not an assertion that Bulla has passed usability or
accessibility testing. Do not copy proprietary fonts, website assets or
unlicensed stock photos.

## Production architecture and operations

- [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod):
  review security and database performance, rehearse load and have recovery
  arrangements before launch. Existing migrations are not hosted evidence.
- [Supabase pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits):
  size database and connection budgets intentionally. The current
  `supabase-js` path uses the HTTP Data API; Supavisor/transaction-pooling
  advice applies to future direct SQL/worker clients, not blindly to every
  HTTP request.
- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes):
  subscriber authorization/fan-out can become a bottleneck. Use small
  authorized conversation channels; evaluate private Broadcast for larger
  fan-out and reconcile from durable storage.
- [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits):
  concurrent connection and event limits depend on project configuration.
  Review the actual project's limits during staging; do not assume a free
  development tier meets the target or that 50,000 accounts means 50,000
  WebSockets.
- [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html):
  authorize upload/download, bound size, validate actual content, generate
  safe names and isolate untrusted files. Planned uploads must not be added
  as an unrestricted public bucket.
- [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  record security/operational outcomes with safe structured fields, without
  passwords, tokens or private message bodies.

Architecture recommendations in [PLAN.md](PLAN.md) are project-specific
inferences from this guidance and the inspected source. No external
infrastructure was provisioned or billed.

## Dependency finding

`npm audit --omit=dev --json` identified the pinned Zod 4.4.3 as affected by
an oversized-collection resource-consumption advisory.
[GitHub advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

The published patched line was verified against the author's
[Zod releases](https://github.com/colinhacks/zod/releases).
The first recovery slice pins 4.6.7 and refreshes the lockfile without running
package installation scripts. A repeat production-only audit reports zero
known advisories. This does **not** prove the app is secure or resolve
separate development-dependency advisories.

## Decisions

| ID | Decision | Why / revisit condition |
| --- | --- | --- |
| D01 | Keep `E:\Uni-Social-Network` as the source checkout | It contains newer dirty work and runtime links; move only with an explicit safe migration |
| D02 | August variants are references, not a rebuild baseline | One is a shallow scaffold; the other is a non-persistent demo |
| D03 | Public brand is Bulla; preserve internal legacy compatibility | Existing sessions/preferences/data must not disappear during a naming change |
| D04 | Versioned project Markdown is canonical; D-drive files are task checkpoints | Both repo collaborators and future local sessions can resume |
| D05 | Modular monolith with Supabase/Postgres, not an immediate microservice rewrite | Fix and measure the substantial existing foundation before introducing distributed complexity |
| D06 | 50,000 registered accounts is the initial target | Concurrent use and traffic shape remain assumptions until staging measurement |
| D07 | Local JSON remains a private development adapter | It is not a database for public scale or multiple app instances |
| D08 | Core campus journeys and abuse controls precede extra features | A reliable small product is the prerequisite for widening scope |
| D09 | No scheduled automation was created | The user specified storage location, not frequency or a recurring prompt |
| D10 | No push, remote rename, deployment, live migration or paid resource creation | Those would alter external state and need the appropriate authorization/choices |
# Continuation research — 31 October 2026

Opened current primary sources during the completion pass:

- [Carbon motion](https://www.carbondesignsystem.com/building-blocks/foundations/motion/overview):
  use quick, quiet interaction feedback; reserve stronger motion for occasional
  meaningful transitions. Bulla keeps reduced-motion support and avoids constant
  animation around reading/writing controls.
- [Carbon accordion guidance](https://www.carbondesignsystem.com/building-blocks/core/components/accordion/guidelines):
  reveal secondary content on demand, without hiding essential work or refusal
  information. This informs the calmer university request panel and single
  messaging creation surface.
- [Playwright page assertions](https://playwright.dev/docs/api/class-pageassertions):
  assert actual URL/visible outcomes after a real action. Browser evidence—not
  this documentation—identified Bulla's open development-stream harness issue.
- [Supabase billing quotas](https://supabase.com/docs/guides/platform/billing-on-supabase)
  and [pricing](https://supabase.com/pricing): free staging is available, but
  50,000 auth MAU is not a database/load guarantee. The documented Free database
  is 500 MB and the Realtime peak allowance is 200 connections, below the
  proposed 1,000-session Realtime capacity test. No paid resource was created.

The interpretations above are Bulla design/engineering decisions, not claims
that a reference design system establishes accessibility or production readiness.

