# Bulla — website guide

Updated 3 November 2026, Asia/Karachi. These destinations describe current
source. [STATUS.md](STATUS.md) distinguishes tested local journeys from
unfinished hosted/device/capacity acceptance. The private preview is
`http://127.0.0.1:3000`; it is not a public student website.

The separate hosted preview is
[bulla-tau.vercel.app](https://bulla-tau.vercel.app). Existing local accounts
were not copied there. Before account testing, complete the actual sender,
confirmation and redirect checks in [FREE-HOSTING.md](FREE-HOSTING.md).
Public-page acceptance is not evidence that signed-in features/MFA/mail passed.
Public build/configuration diagnostic routes and links are now hidden, with
live404/no-disclosure checks accepted. Use Help or Report a bug for feedback,
not `/status` or `/setup`. The owner's existing account is assigned admin
including moderator powers; staff use their personal login, their own
authenticator at `/settings/security`, then `/admin`.

## Join and choose your audience

1. **Join Bulla** → `/signup`: name, email, unique password and terms.
   Current minimum is 15 characters; hosted maximum is 72 UTF-8 bytes.
2. Hosted signup requires a real delivered confirmation link. A check-email
   screen does not prove delivery/account existence. Google appears only when
   the hosted provider enables it. Local accounts have neither.
3. Finish `/onboarding`: username/display name; campus details are optional,
   self-declared and not university-verified.
4. Profile audience starts **Private — only me**. Choose connections,
   university or public intentionally, then **Finish and go to my profile**.
5. Sign in later at `/login` with your **email**, not username.

`/me` is your profile; `/me/edit` edits profile/portfolio; `/me/skills` manages
self-declared skills. Editing a profile never grants site staff permission.

## Menus and notifications

The avatar, bell and campus/hamburger control open dropdown panels first.
Opening them does not navigate or mark notifications read. Select a link to
navigate, or an explicit read control to update activity. Escape, Close and
outside interaction dismiss panels; appearance controls offer light/dark.

The avatar links profile/edit, Followers, Following, Connections and settings,
plus Sign out. Campus navigation exposes staff links only to authorized staff.
The bell shows at most five sanitized previews; `/notifications` has the
full eligible list. An unavailable count is not zero. Require confirmed read
outcomes; UI rendering alone is not a successful write. Notifications are
in-app activity, not guaranteed phone push or email.

## Feed and saved posts

At `/feed`, select **For you** or **Following**. Enter **Post body**, review
audience/attachments, then submit and confirm the stored result. The composer
defaults to university, not private; author/attachment privacy can restrict it.
Use allowed Like, comment/reply, Save and `/post/<POST_ID>` permalink controls.

`/saved` is your private saved-post list, not an archive: posts can disappear
when you lose read access. Load-more controls page through eligible results.
Supported composer drafts are tab-local browser storage, not published data
or cross-device backups. Wait for readiness and accepted feedback/reload.

## Discover people and manage relationships

Use `/feed/people` or `/search?type=people` for university/department/skills.
`/search` also finds supported work; not private messages/private-profile totals.
Open `/u/<USERNAME>` for authorized Follow, Connect, Message, Block and Report.
Following is not an accepted connection or permission to read private content.

| Destination | List |
| --- | --- |
| `/connections/followers` | Your eligible followers. |
| `/connections/following` | People you follow; also reachable from the avatar. |
| `/connections` | Your accepted connections only. |
| `/connections/requests` | Incoming/outgoing accept/decline/cancel workflow; pending is not accepted. |
| `/connections/blocked` | Your block management. |
| `/u/<USERNAME>/followers`, `/u/<USERNAME>/following` | Eligible lists for a readable public subject. |

Your counters link to your lists. Others' public profiles offer followers/
following, not private connections or pending requests. Private, blocked,
inactive/deleted peers are filtered as applicable. Counts/paging are
privacy-aware; provider failure is not an empty list or fabricated zero.

## Projects, ideas and invitations

`/projects` offers **Open to join** and your work. `/projects/new` makes you
owner and starts private. Review **Who can see it** and **Seeking members**;
private projects cannot advertise for members.

At `/projects/<SLUG>`, read allowed details/team/updates and **Ask to join**
when offered. Owners/maintainers manage Requests (`?tab=requests`), settings
(`?tab=settings`) and team controls. Only the owner can **Make owner**;
the former owner remains a maintainer. Project roles are not site staff roles.

At `/ideas` and `/ideas/<IDEA_ID>`, pitch, vote or offer help as permitted.
Ideas currently default public: deliberately review the audience. Eligible
author conversion creates a project and invitations to eligible people, not
automatic membership. Respond at `/projects/invitations` or the offered
notification/project entry using **Accept invitation**/**Decline invitation**.
Pending invitations do not reveal private project content.

Work cannot become more public than the author's permitted profile audience.
Read any stored-visibility warning rather than assume your requested audience
was accepted. Legacy content is not automatically republished.

## Messages and groups

At `/messages`, enter **Their handle** → **Start conversation**, or use the
profile's Message link. Readability/preferences/blocks/current membership are
rechecked; a username or readable history is not consent to a new message.

**Create group** accepts a name and accepted-connection handles: currently up
to 10 supplied handles/request and 20 active people including you. Eligible
people join immediately, not through project-style pending invitations.
Only active group admins can add people, change group roles or remove members.
The last admin must appoint another before leaving/demotion.

Leaving/removal preserves permitted membership-interval history, not later
messages or absent-gap history on rejoining. Use offered Mute/Unmute/Leave
controls. Require accepted sends/read outcomes and refresh/retry after
interruption. Drafts/optimistic bubbles are not durable delivery.
Local mode does not establish real hosted Realtime/multi-device acceptance.

## Learning, events and opportunities

`/goals` manages terms/courses, positive-target goals, progress/milestones and
earned achievements. Goals start private; publication is an explicit choice.
Use `/goals`, not an absent `/semester` route. `/log` saves a daily entry;
saving again updates that day. Days/streaks use UTC (midnight UTC is 5 am in
Karachi). Stored activity is not verified grades or guaranteed skill mastery.

`/opportunities` and `/opportunities/new` provide listings; details contain
deadline/external application information. Save is a bookmark, not an
application or application-tracking workflow.

`/events` and `/events/new` provide events. Check timezone/date/location/link/
capacity. Going takes a place; Interested does not. An error/full/cutoff
refusal is not a confirmed place. Do not disclose private attendees/host data.

Board forms currently default public. Review audiences carefully. A
university-only opportunity without an institution can be stored public with
a warning in the current implementation: do not use that case for confidential
campus content. Listings/institutions are not automatic verified endorsements.

## Report issues

Use Report on an eligible readable post/comment/project/idea/message/profile/
event/opportunity. Select a reason and necessary detail; open duplicates are
refused. `/report-a-bug` is for technical problems, not misconduct. Include
reproduction steps, expected/actual result and redacted context; view your
submitted reports there. Only administrators triage technical-report status.
Never include passwords, authentication codes or unnecessary private messages.

## Settings, password and account data

`/settings` offers appearance and **Save privacy settings**: profile audience,
message/connection preferences and discovery are separate choices. Message
Nobody blocks new direct conversations and incoming direct messages in
existing threads while permitted history remains. Unsaved controls are not
saved settings. Email-address changes are not implemented.

At `/settings/password`, verify the current password and repeat a different
new password. Confirmed changes sign out sessions. If global sign-out fails,
use **Retry sign-out on all devices**, not another password change. Hosted
refresh-session revocation is not instant expiry of every issued access token.

`/reset-password` needs enabled hosted email, the reviewed one-time recovery
template and a real delivered link. Local mode has no forgotten-password
email recovery. Recovery is not a staff-MFA bypass.

`/settings/account` offers reauthenticated **Download own data**: bounded JSON
pages (default 25/max 100 rows/section; 2 MiB/response), not an unlimited archive.
Use Next page and verification for remaining data. Exports exclude credentials,
other senders' messages/private rows, internal notes and media bytes/backups.
Keep downloads private. This interface requires JavaScript.

Deletion is optional/destructive. Read ownership/retention blockers, transfer
shared projects first and reauthenticate before **Confirm account deletion**.
Type `DELETE MY ACCOUNT` and acknowledge the policy. Last-admin, ownership,
media or strong-verification blockers can refuse a request.
An accepted request disables access immediately; queued/processing/retry is
not finished cleanup. Keep its private status-only receipt and use
`/settings/account/deletion`. Hosted cleanup requires an accepted enabled
worker/operator. Backup/provider retention is separate from product cleanup.

## Installation and readiness

Use **Install Bulla** when supported on HTTPS/localhost. Installation does not
make private pages/messages available offline or add phone push delivery.
Sign out on shared devices.

Hosted uploads/cleanup, identity/email/MFA/RLS/Realtime, recovery, device QA
and capacity still require their own accepted evidence. See STATUS; no
production readiness or 50,000-user capacity guarantee exists.
Staff guides: [Administrator](ADMIN-GUIDE.md), [Moderator](MODERATOR-GUIDE.md).
