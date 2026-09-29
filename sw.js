/* 가림 service worker — makes the app work fully offline. No request ever leaves for another origin. */
const VERSION = 'aaa601aaa9'
const SHELL = `garim-shell-${VERSION}`
// v2: the v1 cache could hold stale copies of files replaced under the same name
const RUNTIME = 'garim-runtime-v2'
const PRECACHE = ["./","assets/FileView-CPxMhXdQ.js","assets/ImageView-xN9ApHd5.js","assets/assetUrl-Dqy4ZHmo.js","assets/deskew-BzNPNrIM.js","assets/face-api.esm-CAOM8KdR.js","assets/faces-CQ89Vmz2.js","assets/index-CiXul5Ob.css","assets/index-QjF9pm_N.js","assets/jszip-B7Fa2WXl.js","assets/ocr-DrQkLTy0.js","assets/pdf.worker.min-BmVo14Nb.mjs","assets/pdfjs-B0j_fTeL.js","assets/react-5MitFGcr.js","assets/redact-C6_DWxIm.js","assets/rolldown-runtime-C0FnF6B9.js","assets/src-SuYvKHvm.js","favicon.svg","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","manifest.webmanifest"]

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
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => (k.startsWith('garim-shell-') && k !== SHELL) || (k.startsWith('garim-runtime-') && k !== RUNTIME))
            .map((k) => caches.delete(k)),
        ),
      )
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

  const path = url.pathname
  // Files that are replaced under the same name (demo videos, the extension zip): always from the
  // network, never from a stale copy
  if (/\/demo\//.test(path) || path.endsWith('.zip')) return

  // Content that never changes under its name (hashed bundles, OCR/face models, pdf.js data,
  // fonts): cache first
  if (/\/(assets|ocr|face|pdfjs)\//.test(path) || path.endsWith('.woff2')) {
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
    return
  }

  // Everything else (icons, manifest…): fresh when online, cached copy when offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone()
          caches.open(RUNTIME).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || Response.error())),
  )
})
