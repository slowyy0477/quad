/* Bulla caches only the public offline help screen and its own app icons. */
const CACHE_NAME = 'bulla-public-shell-v2'
const PUBLIC_SHELL = ['/offline.html', '/icons/bulla-192.png', '/icons/bulla-512.png', '/icons/bulla-maskable-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PUBLIC_SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => (name.startsWith('bulla-public-shell-') || name.startsWith('quad-public-shell-')) && name !== CACHE_NAME).map((name) => caches.delete(name)),
  )).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  // Authentication, mutations, APIs and RSC payloads always go directly online.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')) return

  if (PUBLIC_SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(request)))
    return
  }
  // No user page is ever saved. Offline navigation shows public help, never an
  // old user's inbox, profile, admin screen, authentication form or account data.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () =>
      (await caches.match('/offline.html')) || new Response('Bulla needs a connection. Please reconnect.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    ))
  }
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})
