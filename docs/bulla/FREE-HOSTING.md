# Bulla — hosted pilot and owner setup

Updated 3 November 2026, Asia/Karachi.

## Public address and actual state

Main address: [bulla-tau.vercel.app](https://bulla-tau.vercel.app).
The corrected Node24 deployment `dpl_3yWziyCbUhbiwHaWZJ1bdZ7TNJo5` is
promoted on Vercel. Public HTML opens without a Vercel account. Final privacy
verification passed **29 checks / 0 failures**, covering diagnostic404/
no-disclosure, public HTTP/Chrome pages and anonymous staff refusals only.
Earlier24/24 API/PWA smoke retains its separate earlier-source scope.
See STATUS and task-drive `access-privacy-20261103/PROGRESS.md`.
No paid upgrade or purchased domain is required
to open this provider address.

This is an early preview, not production/security/recovery/50,000-user
capacity acceptance. Account testing is not ready merely because signup renders.
Real email delivery, confirmation redirects and signed-in/staff journeys
still need acceptance.

- Vercel Hobby project: `bulla`, scope `thor14899-2509`.
- Live source: pushed commit `831691a`; actual Node24.x functions / `arn1`.
- Supabase Free project: `bulla`, ref `nqnfuomyalbhbwapgots`.
- All source migrations 0001–0040 are installed and their history aligned.
- All 59 public tables have RLS; client staff-role writes are refused.
- No local accounts, passwords, media or owner data were imported.
- Latest exact-account read-back: selected owner account confirmed/active/
  onboarded and holding admin, which includes moderator powers. Its guarded
  grant is complete; personal MFA has zero verified factors and remains required.
- Hosted image writes and incomplete cleanup-worker rollout remain off.
- Google is off; one-time email recovery configuration is not accepted.
- No purchased domain, paid upgrade or recurring schedule was created.

## Before inviting classmates to create accounts

The connected database tools do not expose hosted Auth configuration, there
is no saved management token/SMTP configuration in the checked owner
environment, and dashboard-control runtimes are unavailable. Do not assume
the provider's current mail sender or redirects have been verified.

The confirmed/onboarded account metadata is useful state evidence, not an
observed mail-delivery test for arbitrary classmates. Confirm configuration
and a real journey before inviting them to register.

In the [selected Supabase project](https://supabase.com/dashboard/project/nqnfuomyalbhbwapgots):

1. Open [Authentication → URL Configuration](https://supabase.com/dashboard/project/nqnfuomyalbhbwapgots/auth/url-configuration).
2. Set **Site URL** to `https://bulla-tau.vercel.app`.
3. Allow the exact destinations used by the current email flow:

   ```text
   https://bulla-tau.vercel.app/auth/callback
   https://bulla-tau.vercel.app/auth/callback?next=/onboarding
   https://bulla-tau.vercel.app/auth/recovery
   ```

4. Keep email confirmation enabled and the provider minimum password length
   at least 15. Do not enable Google before its own callback/identity setup.
5. Configure an SMTP sender you control in
   [Authentication → SMTP Settings](https://supabase.com/dashboard/project/nqnfuomyalbhbwapgots/auth/smtp).
   Keep SMTP credentials inside protected provider setup, never chat/Git/docs.
6. Use your own email for one real signup, open the delivered confirmation,
   finish onboarding, sign out and sign back in. Verify the final URL and
   persistence before inviting other people.

If the project still uses Supabase's default sender, it sends only to
organization-team addresses and is currently limited to two emails per hour.
Do **not** add classmates as infrastructure team members to work around this.
Use an appropriate sender; do not disable confirmation and then claim that
emails are verified.
[Official SMTP limits and setup](https://supabase.com/docs/guides/auth/auth-smtp).

Password recovery additionally needs the reviewed TokenHash template in
`src/features/auth/recovery-email.html`, actual delivery/replay tests and only
then the server setting `BULLA_RECOVERY_EMAIL_TEMPLATE=token_hash`. It remains
unavailable until that protocol is accepted; a default email template is not
the same protocol.

## Administrator and moderator access

There is no separate/shared staff password. Sign in at
[the normal login](https://bulla-tau.vercel.app/login), using a personal
hosted account. The selected owner account is already granted `admin`, including
moderator powers; no owner SQL step remains. Future staff require their own
verified, approved exact-UUID grant through [ADMIN-GUIDE.md](ADMIN-GUIDE.md).

Then enroll/verify your authenticator at
[Security settings](https://bulla-tau.vercel.app/settings/security), and open
[the staff workspace](https://bulla-tau.vercel.app/admin).
Fresh MFA assurance expires after five minutes. Enrollment must be performed
personally with an authenticator the account owner controls; no password reset,
forced confirmation or MFA bypass was used. The selected existing hosted
account received its approved role; local credentials were not imported.

Public `/status` and `/setup`, including prefetch/data variants, now return404
with neutral text. Internal implementation/configuration links and details are
not public navigation. This does not claim that every feature is finished.

Admin includes moderator powers plus bug triage; moderators have reports,
university requests and audit reading. Neither role grants Vercel/Supabase
ownership, and the website has no staff appointment interface.
See [moderator guide](MODERATOR-GUIDE.md). `/admin/data` explains its local-only
scope; use the authorized Supabase dashboard for hosted data.

## Feedback and updates

Once account acceptance passes, start with a small invited cohort. Students
can use [Report a bug](https://bulla-tau.vercel.app/report-a-bug); admins triage
at [Bug reports](https://bulla-tau.vercel.app/admin/bug-reports).
Do not include passwords, codes or private conversations in shared reports.

Source remains `E:\Uni-Social-Network`. `E:\Bulla` is an entry point. Preserve
the ignored local preview environment and use only the reviewed allowlisted
snapshot workflow for deployment. Logs, screenshots and checkpoints belong
under `D:\All tasks + Automations\Bulla-Recovery`.

Automatic Vercel Git deployment still lacks the owner's GitHub Login
Connection; Git pushes and the separately authenticated CLI deployment work.
Do not imply that a push alone redeploys this site.

Rollback the application by promoting a separately reviewed earlier
compatible deployment. The unused first build selected Node 26 and is not
the accepted runtime. Database rollback requires a reviewed forward
correction/recovery plan, never reset/replay of existing migrations.
