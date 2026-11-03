import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Student guide' }

const sections = [
  { title: '1. Create your own account', text: 'Choose Join Bulla and use an email address you can remember. Choose a unique password and keep it in your password manager. Sign in with that same email—not your public username.', links: [['/signup', 'Create account'], ['/login', 'Sign in']] },
  { title: '2. Set up your student profile', text: 'Add your name, university, department and semester. Pick the visibility you want in Settings. Your public username is the link other students use to find your profile; it is separate from your sign-in email.', links: [['/onboarding', 'Finish setup'], ['/me', 'My profile'], ['/settings', 'Privacy & account settings']] },
  { title: '3. Find your campus and people', text: 'Search for classmates, skills and projects. Visit a profile before sending a connection request. Connect with people you know and use blocking/reporting when necessary; never send passwords or sensitive documents in a message.', links: [['/search', 'Search Bulla'], ['/universities', 'Universities'], ['/connections', 'Connections']] },
  { title: '4. Build together', text: 'Publish a project with its goal, required skills and collaboration needs. Open its detail page to see updates and membership. Share a smaller idea when it is not ready to be a full project yet.', links: [['/projects', 'Projects'], ['/ideas', 'Ideas'], ['/opportunities', 'Opportunities'], ['/events', 'Campus events']] },
  { title: '5. Keep learning organized', text: 'Create a semester, add courses, then add goals and milestones. Record study sessions in your daily log. Progress is calculated from your saved work; a streak is a record of activity, not a grade or a guarantee of learning.', links: [['/goals', 'Learning goals'], ['/semester', 'Semesters'], ['/log', 'Study log']] },
  { title: '6. Manage conversations and updates', text: 'Use Messages for direct conversations and Notifications for activity involving your account. Check that a message is visible after sending before closing the app. Notifications inside Bulla are not the same as phone push notifications.', links: [['/messages', 'Messages'], ['/notifications', 'Notifications']] },
] as const

export default function HelpPage() {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
    <p className="text-xs font-semibold tracking-widest text-accent-700 uppercase">The student handbook</p>
    <h1 className="mt-3 text-3xl sm:text-4xl">One account. Your campus in reach.</h1>
    <p className="mt-4 max-w-2xl text-ink-muted">Start small: finish your profile, find a classmate, then publish one thing you are building or learning. You do not need an administrator account to use Bulla.</p>
    <div className="mt-8 grid gap-5 md:grid-cols-2">{sections.map((section) => <section key={section.title} className="rounded-xl border border-hairline bg-paper-raised p-5 sm:p-6">
      <h2 className="text-lg">{section.title}</h2><p className="mt-3 text-sm text-ink-muted">{section.text}</p>
      <div className="mt-4 flex flex-wrap gap-2">{section.links.map(([href, label]) => <Link key={href} href={href} className="inline-flex min-h-11 items-center rounded-lg border border-rule px-3 text-sm font-medium text-accent-700 hover:bg-accent-50">{label}</Link>)}</div>
    </section>)}</div>
    <section className="mt-8 rounded-xl border border-rule bg-paper-raised p-6">
      <h2 className="text-xl">Install Bulla on your phone or laptop</h2>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm text-ink-muted"><li><strong>Android / desktop Chrome or Edge:</strong> use Install Bulla when the button appears, or choose Install app from your browser menu.</li><li><strong>iPhone / iPad:</strong> open Bulla in Safari, tap Share, then Add to Home Screen.</li><li><strong>Offline:</strong> the installed app shows a connection-help screen. It does not save your private pages, messages, or unsent forms for offline use.</li></ol>
      <p className="mt-4 text-sm text-ink-muted">Installation requires HTTPS, except when testing on localhost. A plain HTTP address on your home Wi-Fi is not an installable public PWA.</p>
    </section>
    <section className="mt-6 rounded-xl border border-rule p-6">
      <h2 className="text-xl">Important limits of this laptop version</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-ink-muted"><li>Localhost works only on the laptop running Bulla. Students elsewhere need a deployed HTTPS website.</li><li>Email verification and email password-reset delivery are not configured. If you forget your password, contact the site operator; never share your password with them.</li><li>This private local version is not approved for 10,000 users. Public launch needs a production database, mail delivery, hosting, backups and a separate load test.</li><li>Sign out when sharing a device. Admin accounts should never be shared with classmates.</li></ul>
      <Link href="/report-a-bug" className="mt-5 inline-flex min-h-11 items-center text-sm font-semibold text-accent-700 underline underline-offset-4">Report a problem</Link>
    </section>
  </div>
}
