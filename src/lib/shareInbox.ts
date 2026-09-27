/** Photos shared to the installed app (see the service worker's share target). */
const SHARE_CACHE = 'garim-share'
const FLAG = 'garim:shared-images'

/** Remembers that shared photos are waiting (the image view picks them up when it opens). */
export function markSharedImages() {
  try {
    sessionStorage.setItem(FLAG, '1')
  } catch {
    /* ignore */
  }
}

/** Returns the shared photos (once) and clears them from the local cache. */
export async function takeSharedImages(): Promise<File[]> {
  try {
    if (sessionStorage.getItem(FLAG) !== '1') return []
    sessionStorage.removeItem(FLAG)
  } catch {
    return []
  }
  if (typeof caches === 'undefined') return []
  const cache = await caches.open(SHARE_CACHE)
  const files: File[] = []
  for (const req of await cache.keys()) {
    const res = await cache.match(req)
    if (!res) continue
    const blob = await res.blob()
    const name = decodeURIComponent(res.headers.get('x-name') ?? 'shared-image')
    files.push(new File([blob], name, { type: blob.type || res.headers.get('content-type') || 'image/png' }))
  }
  await caches.delete(SHARE_CACHE)
  return files
}
