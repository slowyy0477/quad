import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Compass, FolderKanban, Target } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CampusArtwork } from '@/components/ui/campus-artwork'
import { isDataConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { getUser } from '@/lib/supabase/server'

const destinations = [
  { href: '/search', title: 'Find your people', Icon: Compass },
  { href: '/projects', title: 'Build something together', Icon: FolderKanban },
  { href: '/goals', title: 'Make room to learn', Icon: Target },
] as const

/** Describe the real product without invented members, metrics or security promises. */
export default async function HomePage() {
  const local = isLocalMode()
  const configured = isDataConfigured()
  const user = configured ? await getUser() : null
  return (
    <div className="page-enter mx-auto w-full max-w-7xl px-4 sm:px-6">
      {!configured ? <Alert tone="warning" title="Account service unavailable" className="mt-6"><p>Accounts and student content are temporarily unavailable. <Link href="/help">Get help</Link>.</p></Alert> : null}
      <section className="landing-hero">
        <div className="min-w-0">
          <p className="commons-note">The campus commons, online</p>
          <h1 className="landing-title mt-6">Your campus.<br /><span className="text-accent-700">A little closer.</span></h1>
          <p className="mt-6 max-w-md text-lg text-ink-muted">Meet people who get your ideas. Make something together. Keep a little space for what you want to learn.</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {user ? <Button asChild variant="primary" size="lg"><Link href="/feed">Back to your feed<ArrowRight aria-hidden="true" /></Link></Button> : <>
              <Button asChild variant="primary" size="lg"><Link href="/signup">Find your place<ArrowRight aria-hidden="true" /></Link></Button>
              <Button asChild variant="secondary" size="lg"><Link href="/login">Sign in</Link></Button>
            </>}
          </div>
          <p className="mt-5 max-w-lg text-xs text-ink-muted">{local ? 'Private preview · your data stays on this computer.' : 'An independent student community, in development.'}</p>
        </div>
        <aside className="campus-canvas" aria-labelledby="workspace-map-heading">
          <div className="flex items-center justify-between gap-4">
            <h2 id="workspace-map-heading" className="text-base">A campus. More possibilities.</h2>
            <span className="text-xs text-ink-faint">Bulla</span>
          </div>
          <CampusArtwork className="my-4" />
          <nav aria-label="Explore Bulla">
            {destinations.map(({ href, title, Icon }) => <Link key={href} href={href} className="campus-destination">
              <Icon className="size-[1.125rem] shrink-0 text-accent-700" aria-hidden="true" />
              <span className="min-w-0 flex-1">{title}</span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>)}
          </nav>
        </aside>
      </section>
      <section className="py-8 sm:py-12" aria-labelledby="student-life-heading">
        <div className="mb-8"><p className="eyebrow">Outside the timetable</p><h2 id="student-life-heading" className="mt-3 text-3xl">People. Projects. A little progress.</h2></div>
        <div className="grid gap-7 md:grid-cols-3">
          {[
            ['01', 'An idea doesn’t need to start big.', 'Share the thing you’re working on. Say what you need help with. Find someone who wants to figure it out with you.', '/projects', 'Find a project'],
            ['02', 'Progress is easier to see when you keep it.', 'Set a learning goal and write a small study log. Come back to what you’ve done, not just what’s still on your list.', '/goals', 'Make a learning goal'],
            ['03', 'Campus life isn’t all in one group chat.', 'Look for student events and opportunities. Meet people through the things you care about, and take the next conversation from there.', '/events', 'Look around campus'],
          ].map(([number, title, body, href, label]) => <article key={number} className="home-feature">
            <span aria-hidden="true" className="inline-block w-6 font-mono text-xs whitespace-nowrap text-accent-700">{number}</span><div className="mt-3 min-w-0"><h3 className="text-xl">{title}</h3><p className="mt-3 text-sm text-ink-muted">{body}</p><Link href={href} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent-700">{label}<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
          </article>)}
        </div>
      </section>
      <section className="mb-12 flex flex-col items-start justify-between gap-6 border-y border-rule py-8 sm:mb-16 sm:flex-row sm:items-center sm:py-10">
        <div><h2 className="text-2xl">Start with yourself.</h2><p className="mt-3 max-w-lg text-sm text-ink-muted">A name, your university, a few interests. The rest can grow from there.</p></div>
        <Button asChild variant={user ? 'secondary' : 'primary'} size="lg" className="w-full shrink-0 sm:w-auto"><Link href={user ? '/me' : '/signup'}>{user ? 'Your profile' : 'Join Bulla'}<ArrowRight aria-hidden="true" /></Link></Button>
      </section>
    </div>
  )
}
