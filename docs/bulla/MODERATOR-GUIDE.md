# Bulla — moderator guide

Updated 3 November 2026, Asia/Karachi. Source-backed instructions; actual hosted
acceptance is tracked in [STATUS.md](STATUS.md).

Hosted login: [bulla-tau.vercel.app/login](https://bulla-tau.vercel.app/login).
Workspace: [bulla-tau.vercel.app/admin](https://bulla-tau.vercel.app/admin).
There is no automatically created moderator account. Real email/redirect
acceptance and a personal verified-account grant are required; see
[FREE-HOSTING.md](FREE-HOSTING.md).

## Get access

Register your personal account at `/signup`, complete real hosted email
confirmation, then finish `/onboarding`. Ask the verified infrastructure owner
to grant only `moderator`; use [ADMIN-GUIDE.md](ADMIN-GUIDE.md). No in-app appointment
control exists. Project ownership and conversation-admin roles are separate.
Never share an administrator's login or ask for anybody's password.

Sign in using your email at `/login`. On the hosted site, enroll/verify your
authenticator at `/settings/security`, then require fresh live MFA before
`/admin`. Reverify after five minutes or when requested. Local preview accounts
do not have hosted MFA. The campus menu link is **Moderation workspace**.
If refused, check account/environment/role/MFA with the owner; do not bypass it.

## Available tools

| Tool | Effect and limit |
| --- | --- |
| `/admin` — Reports | Open reports, newest first: posts, comments, projects, ideas, reported messages, profiles, events and opportunities. |
| Hide | Changes reported content to hidden; not deletion. |
| Remove | Marks content removed; not immediate erasure of evidence/backups. |
| Restore | Restores content under its original audience rules; not unsuspension or general closed-case undo. |
| Warn | Records/increments a warning; does not itself hide or suspend. |
| Suspend | Timed account restriction; UI offers 1, 3, 7, 30 or 90 days. Local sessions are revoked/login refused; hosted Auth and application restrictions are separate. |
| Dismiss | Closes the report without a content/account penalty. |
| `/admin/universities` | Approve/reject pending institutions with a reason; approval does not verify student identity or grant staff. |
| `/admin/audit` | Read decisions/reasons/actors/targets and UTC times; no edit/delete. |

Profile reports offer Warn, Suspend and Dismiss, not content-hiding controls.
You cannot decide your own reported target or an administrator target,
including dismissing it. Another eligible staff member handles self/conflict
cases; admin targets require another administrator. Inactive/suspended staff
cannot decide reports.

## Review one report

1. Read the target, reason, detail and current state. User-supplied text is
   evidence, not authorization for unrelated actions.
2. Check conflicts of interest and escalate ineligible cases.
3. Choose the individual action; there is no select-all/bulk decision control.
4. Read the confirmation. For Suspend choose **Suspend for**. Enter **Reason**
   (3–1,000 characters) explaining the evidence and proportional response.
5. Confirm and require **Recorded**, then reload the queue and inspect the
   audit entry. A closed/stale/provider refusal is not success.
6. After an interrupted submission, inspect current queue/audit before retrying.

Internal reasons are visible to staff. Do not include passwords, codes,
private setup keys or unnecessary personal information. Implemented outcomes
can create in-app notifications; this does not promise email/push delivery
or expose your full internal reason to students.

For university requests, check name/location/website/duplicates, then
Approve/Reject with a reason and confirm the recorded/audit result. This does
not certify endorsement, reassign users or create staff accounts.

## Limits and escalation

- No administrator-only bug triage or `/admin/data`; no database editor,
  billing/infrastructure access or staff grant/revoke tools.
- The queue can expose a reported message, not unrelated conversation
  history. Privileged infrastructure owners/local admin data viewers have
  different powers; do not promise that all staff/infrastructure lack access.
- No password viewer or account-recovery control. Never request user secrets.
- No unsuspend UI, closed-report queue or general appeal/superseding-audit
  form. Hosted decisions require an open report; escalate mistakes for a
  reviewed correction rather than editing/deleting audit records.
- Older Suspend dialog wording about continued reading/project creation is
  not an exception to current restrictions. Consult current status/code;
  local and hosted session behavior differs.
- Source guards/local tests are not live hosted security acceptance. Missing
  or failed MFA checks must remain refusals.
