/* 가림 service worker — makes the app work fully offline. No request ever leaves for another origin. */
const VERSION = '__VERSION__'
const SHELL = `garim-shell-${VERSION}`
const RUNTIME = 'garim-runtime-v1'
const PRECACHE = __PRECACHE__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('garim-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const SHARE = 'garim-share'

/**
 * Web Share Target (installed app on Android): shared photos arrive here as a POST. They are
 * parked in a local cache for the page to pick up — nothing leaves the device.
 */
async function receiveShare(req) {
  const data = await req.formData()
  const images = data.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0)
  const scope = self.registration.scope
  if (images.length) {
    await caches.delete(SHARE)
    const cache = await caches.open(SHARE)
    await Promise.all(
      images.map((f, i) =>
        cache.put(
          new URL(`__share/${i}`, scope).href,
          new Response(f, { headers: { 'content-type': f.type || 'image/*', 'x-name': encodeURIComponent(f.name || `shared-${i + 1}`) } }),
        ),
      ),
    )
    return Response.redirect(new URL('./?share=images#/image', scope).href, 303)
  }
  // text only: same as the old GET share (?title=&text=&url=)
  const q = new URLSearchParams()
  for (const k of ['title', 'text', 'url']) {
    const v = data.get(k)
    if (typeof v === 'string' && v) q.set(k, v)
  }
  return Response.redirect(new URL(`./?${q}`, scope).href, 303)
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share')) {
    event.respondWith(receiveShare(req))
    return
  }
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Share target & navigations: network first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    )
    return
  }

  // Everything else (hashed assets, fonts, OCR models, pdf.js data): cache first
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(RUNTIME).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
