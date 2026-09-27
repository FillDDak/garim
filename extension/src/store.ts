import type { MappingEntry, MaskMode } from '../../src/core/types'

/* Minimal typing for the WebExtension APIs we use (avoids a dependency on @types/chrome). */
declare global {
  const chrome: {
    storage: {
      local: {
        get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
        set: (items: Record<string, unknown>) => Promise<void>
        remove: (keys: string | string[]) => Promise<void>
      }
      onChanged: { addListener: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void }
    }
    tabs?: {
      create: (o: { url: string }) => void
      query: (q: { active: boolean; currentWindow: boolean }) => Promise<Array<{ id?: number; url?: string }>>
      sendMessage: (id: number, msg: unknown) => Promise<unknown>
      reload: (id: number) => Promise<void>
    }
    runtime: {
      onMessage: { addListener: (cb: (msg: unknown, sender: unknown, reply: (r: unknown) => void) => void) => void }
      getManifest: () => { content_scripts?: Array<{ matches?: string[] }> }
    }
  }
}

export interface ExtSettings {
  enabled: boolean
  mode: Exclude<MaskMode, 'redact'>
  notice: boolean
  /** Show original values inside AI answers on the page. */
  reveal: boolean
}

export const DEFAULTS: ExtSettings = { enabled: true, mode: 'token', notice: true, reveal: true }

const TTL = 24 * 3600 * 1000

export async function getSettings(): Promise<ExtSettings> {
  const r = await chrome.storage.local.get('settings')
  return { ...DEFAULTS, ...((r.settings as Partial<ExtSettings>) ?? {}) }
}

export async function setSettings(patch: Partial<ExtSettings>) {
  const cur = await getSettings()
  await chrome.storage.local.set({ settings: { ...cur, ...patch } })
}

interface Stored {
  mapping: MappingEntry[]
  updatedAt: number
}

/** One mapping per site so placeholders stay consistent within a conversation site. */
export async function getMapping(host: string): Promise<MappingEntry[]> {
  const key = 'map:' + host
  const r = (await chrome.storage.local.get(key))[key] as Stored | undefined
  if (!r || Date.now() - r.updatedAt > TTL) return []
  return r.mapping
}

export async function setMapping(host: string, mapping: MappingEntry[]) {
  await chrome.storage.local.set({ ['map:' + host]: { mapping, updatedAt: Date.now() } satisfies Stored })
}

export async function clearMappings() {
  const all = await chrome.storage.local.get(null)
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('map:')))
}
