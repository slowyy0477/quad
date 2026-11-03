'use client'

import { useEffect, useState } from 'react'
import { Download, RefreshCw, WifiOff } from 'lucide-react'

type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Install affordance and online status; this never stores account data. */
export function PwaControls() {
  const [install, setInstall] = useState<InstallEvent | null>(null)
  const [offline, setOffline] = useState(false)
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    const onOffline = () => setOffline(true)
    const onOnline = () => setOffline(false)
    const onInstall = (event: Event) => {
      event.preventDefault()
      setInstall(event as InstallEvent)
    }
    const onInstalled = () => setInstall(null)
    queueMicrotask(() => setOffline(!navigator.onLine))
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    window.addEventListener('beforeinstallprompt', onInstall)
    window.addEventListener('appinstalled', onInstalled)
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((registration) => {
        if (registration.waiting) setWaiting(registration.waiting)
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker)
          })
        })
      }).catch(() => {
        // Browsing stays available if this browser does not support installation.
      })
    }
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('beforeinstallprompt', onInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!offline && !install && !waiting) return null
  return (
    <aside aria-label="App connection and installation" className="border-b border-rule bg-paper-raised">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
        {offline ? <p role="status" className="flex items-center gap-2 text-warning-600"><WifiOff className="size-4" aria-hidden="true" />Offline. Reconnect before saving changes.</p> : <p className="text-ink-muted">Keep your campus workspace one tap away.</p>}
        <div className="flex flex-wrap gap-3">
          {install ? <button type="button" onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null) }} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 font-semibold text-accent-700 hover:bg-accent-50"><Download className="size-4" aria-hidden="true" />Install Bulla</button> : null}
          {waiting ? <button type="button" onClick={() => { if (!window.confirm('Save any unsent work first. Reload Bulla to apply this update?')) return; navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true }); waiting.postMessage({ type: 'SKIP_WAITING' }) }} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 font-semibold text-accent-700 hover:bg-accent-50"><RefreshCw className="size-4" aria-hidden="true" />Update app</button> : null}
        </div>
      </div>
    </aside>
  )
}
