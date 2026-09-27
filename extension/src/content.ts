/**
 * 가림 content script: masks personal information when you paste into an AI chat box and
 * (optionally) shows the original values inside the AI's answers — all locally.
 */
import { defaultDetectOptions, detect } from '../../src/core/engine'
import { AI_NOTICE, applyMask, mergeMapping } from '../../src/core/mask'
import { restore } from '../../src/core/restore'
import type { MappingEntry } from '../../src/core/types'
import { getMapping, getSettings, setMapping, setSettings, type ExtSettings } from './store'

const host = location.host
/**
 * After the extension is updated, the previous copy of this script stays in open tabs but
 * can no longer reach the extension. It must then step aside for the freshly injected copy.
 */
const alive = () => {
  try {
    return Boolean(chrome.runtime?.id)
  } catch {
    return false
  }
}
let settings: ExtSettings
let mapping: MappingEntry[] = []
let bypassNext = false

// ─── UI (shadow DOM so the host page's CSS can't interfere) ────────────────
const rootEl = document.createElement('garim-root')
const shadow = rootEl.attachShadow({ mode: 'closed' })
shadow.innerHTML = `
<style>
  :host { all: initial; }
  .wrap { position: fixed; right: 18px; top: 64px; z-index: 2147483646; display: flex; flex-direction: column-reverse; align-items: flex-end; gap: 8px; pointer-events: none;
    font-family: 'Pretendard Variable', Pretendard, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif; font-size: 13px; letter-spacing: -0.01em; }
  .toast, .pill { pointer-events: auto; }
  .toast { background: #16181f; color: #f2f3f7; border-radius: 12px; padding: 10px 12px 10px 14px; box-shadow: 0 16px 40px -12px rgba(0,0,0,.5);
    display: flex; align-items: center; gap: 10px; max-width: 380px; animation: in .2s ease; }
  .toast b { color: #b6a8ff; }
  .toast button { all: unset; cursor: pointer; color: #b6a8ff; font-weight: 700; padding: 4px 6px; border-radius: 6px; white-space: nowrap; }
  .toast button:hover { background: rgba(255,255,255,.08); }
  .pill { all: unset; cursor: pointer; display: flex; align-items: center; gap: 7px; background: #fff; color: #3d4354; border: 1px solid #e3e6ec; border-radius: 999px;
    padding: 6px 12px 6px 8px; box-shadow: 0 6px 18px -8px rgba(17,22,40,.35); font-weight: 650; font-size: 12.5px; }
  .pill.on { background: #efebff; border-color: #cfc5ff; color: #4b33d6; }
  .pill .logo { width: 18px; height: 18px; border-radius: 6px; background: linear-gradient(135deg,#7b5cff,#3f2bd6); display: grid; place-items: center; }
  .pill .logo i { display:block; width: 10px; height: 3px; background:#0d0a24; border-radius: 1px; box-shadow: 0 -4px 0 #fff, 0 4px 0 #fff; }
  .hidden { display: none; }
  @media (prefers-color-scheme: dark) {
    .pill { background: #1b1e27; color: #c3c7d3; border-color: #2a2e3b; }
    .pill.on { background: #231e45; border-color: #3d3480; color: #b6a8ff; }
  }
  @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
</style>
<div class="wrap">
  <div class="toasts"></div>
  <button class="pill hidden" title="가림: AI 답변 속 자리표시자를 원래 값으로 보여 주기 (이 화면에서만)"><span class="logo"><i></i></span><span class="label"></span></button>
</div>`
const toasts = shadow.querySelector('.toasts') as HTMLDivElement
const pill = shadow.querySelector('.pill') as HTMLButtonElement
const pillLabel = shadow.querySelector('.label') as HTMLSpanElement

function toast(html: string, actions: Array<{ label: string; run: () => void }> = [], ms = 6000) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `<span>${html}</span>`
  for (const a of actions) {
    const b = document.createElement('button')
    b.textContent = a.label
    b.onclick = () => {
      a.run()
      el.remove()
    }
    el.appendChild(b)
  }
  toasts.appendChild(el)
  window.setTimeout(() => el.remove(), ms)
}

function updatePill() {
  const n = mapping.length
  pill.classList.toggle('hidden', !settings?.enabled || n === 0)
  pill.classList.toggle('on', settings?.reveal)
  pillLabel.textContent = settings?.reveal ? `원래 값 표시 중 · ${n}개` : `가림 ${n}개 · 원래 값 보기`
}

pill.addEventListener('click', async () => {
  settings.reveal = !settings.reveal
  await setSettings({ reveal: settings.reveal })
  applyReveal()
})

// ─── Paste interception ───────────────────────────────────────────────────
function editableFrom(t: EventTarget | null): HTMLElement | null {
  const el = t instanceof HTMLElement ? t : (t as Node | null)?.parentElement ?? null
  if (!el) return null
  const e = el.closest('textarea, input[type="text"], input:not([type]), [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
  return e as HTMLElement | null
}

/**
 * The app already inserted `pasted` at the caret: select exactly that text and replace it with
 * `masked`. Returns false (changing nothing) when the inserted text can't be found reliably.
 */
async function fixUpAfterApp(target: HTMLElement, pasted: string, masked: string): Promise<boolean> {
  const norm = (x: string) => x.replace(/\s+/g, '')
  const want = norm(pasted)
  const attempt = (): boolean => {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const end = target.selectionEnd ?? target.value.length
      const start = end - pasted.length
      if (start < 0 || target.value.slice(start, end) !== pasted) return false
      target.setSelectionRange(start, end)
      insertText(target, masked)
      return true
    }
    const sel = document.getSelection()
    if (!sel || !sel.rangeCount || !target.contains(sel.focusNode)) return false
    sel.collapseToEnd()
    // grow the selection backwards from the caret until it spans the pasted text
    for (let i = 0; i < pasted.length + 50; i++) {
      sel.modify('extend', 'backward', 'character')
      const got = norm(sel.toString())
      if (got === want) {
        insertText(target, masked)
        return true
      }
      if (got.length > want.length || !want.endsWith(got)) break
    }
    sel.collapseToEnd()
    return false
  }
  // the app may insert synchronously or a moment later
  for (const wait of [0, 60, 200]) {
    await new Promise((r) => setTimeout(r, wait))
    if (attempt()) return true
  }
  return false
}

function insertText(target: HTMLElement, text: string) {
  target.focus()
  // execCommand keeps the host app's undo stack and framework state (React/ProseMirror) in sync
  if (document.execCommand('insertText', false, text)) return
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const s = target.selectionStart ?? target.value.length
    const e = target.selectionEnd ?? s
    target.setRangeText(text, s, e, 'end')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  bypassNext = true
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}

// Registered on window, capture phase, at document_start: runs before any listener the chat app
// adds itself (Gemini and others handle paste early and would otherwise insert the raw text)
window.addEventListener(
  'paste',
  (e) => {
    if (bypassNext) {
      bypassNext = false
      return
    }
    if (!alive() || !settings?.enabled) return
    // the event path is fixed at dispatch time: it still leads to the editor even when the app
    // has already replaced the node the paste landed on
    const target =
      editableFrom(e.target) ??
      e.composedPath().reduce<HTMLElement | null>((found, n) => found ?? (n instanceof HTMLElement ? editableFrom(n) : null), null) ??
      editableFrom(document.activeElement)
    if (!target || rootEl.contains(target)) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text || text.length < 4) return
    const entities = detect(text, defaultDetectOptions())
    if (!entities.length) return

    const r = applyMask(text, entities, new Set(), { mode: settings.mode, tokenLang: 'ko', partialRedact: true }, mapping)
    const isFirst = mapping.length === 0
    const notice = settings.mode === 'token' && settings.notice && isFirst ? AI_NOTICE.ko : ''
    if (e.defaultPrevented) {
      // The chat app handled this paste before us (this copy of the script was added to an
      // already-open tab, after the app's own listeners): swap the text it just inserted
      void fixUpAfterApp(target, text, notice + r.text).then((ok) => {
        if (ok) {
          mapping = mergeMapping(mapping, r.mapping)
          void setMapping(host, mapping)
          updatePill()
          toast(`<b>가림</b> 개인정보 ${entities.length}곳을 가렸어요`)
        } else {
          toast('<b>가림</b> 이 탭에서는 붙여넣은 글을 가리지 못했어요. 새로고침하면 동작해요', [{ label: '새로고침', run: () => location.reload() }], 15000)
        }
      })
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    insertText(target, notice + r.text)
    mapping = mergeMapping(mapping, r.mapping)
    void setMapping(host, mapping)
    updatePill()

    const kinds = [...new Set(entities.map((x) => x.type))].length
    toast(`<b>가림</b> 개인정보 ${entities.length}곳(${kinds}종류)을 가려서 붙여넣었어요`, [
      {
        label: '원문으로',
        run: () => {
          document.execCommand('undo')
          bypassNext = false
          insertText(target, text)
        },
      },
    ])
  },
  true,
)

// ─── Reveal originals inside the page (display only) ──────────────────────
const originalText = new WeakMap<Text, string>()
const touched = new Set<Text>()
/** What we wrote into each node, to tell our own writes from the host app's. */
const revealed = new WeakMap<Text, string>()
let observer: MutationObserver | null = null
let pending = 0

function shouldSkip(node: Text): boolean {
  const p = node.parentElement
  if (!p) return true
  if (p.closest('script, style, noscript, textarea, input, [contenteditable="true"], [contenteditable=""], garim-root')) return true
  return false
}

// Revealed values are marked on screen (CSS Custom Highlight API: no change to the page's DOM
// structure), so it's clear that what the AI received was the placeholder
const HL_NAME = 'garim-revealed'
type HighlightRegistry = { set: (n: string, h: unknown) => void; delete: (n: string) => void }
const cssHighlights = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
let hlStyle: HTMLStyleElement | null = null

function refreshHighlights() {
  if (!cssHighlights || !HighlightCtor) return
  if (!hlStyle) {
    hlStyle = document.createElement('style')
    hlStyle.textContent = `::highlight(${HL_NAME}) { background-color: rgba(123, 92, 255, 0.2); text-decoration: underline dotted rgba(123, 92, 255, 0.9); }`
    ;(document.head ?? document.documentElement).appendChild(hlStyle)
  }
  const ranges: Range[] = []
  const originals = [...new Set(mapping.map((m) => m.original))].filter((o) => o.length >= 2)
  for (const node of touched) {
    if (!node.isConnected) continue
    for (const o of originals) {
      let i = node.data.indexOf(o)
      while (i >= 0) {
        const r = document.createRange()
        r.setStart(node, i)
        r.setEnd(node, i + o.length)
        ranges.push(r)
        i = node.data.indexOf(o, i + o.length)
      }
    }
  }
  if (ranges.length) cssHighlights.set(HL_NAME, new HighlightCtor(...ranges))
  else cssHighlights.delete(HL_NAME)
}

function revealNode(node: Text) {
  if (shouldSkip(node)) return
  const src = originalText.get(node) ?? node.data
  if (!/[[\]【】_]/.test(src) && !mapping.some((m) => src.includes(m.replacement))) return
  const r = restore(src, mapping)
  if (r.restored > 0 && r.text !== node.data) {
    if (!originalText.has(node)) originalText.set(node, src)
    touched.add(node)
    node.data = r.text
    revealed.set(node, r.text)
  }
}

function scan(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) revealNode(n as Text)
}

function unrevealAll() {
  for (const node of touched) {
    const o = originalText.get(node)
    if (o != null && node.isConnected) node.data = o
  }
  touched.clear()
  refreshHighlights()
}

function applyReveal() {
  updatePill()
  observer?.disconnect()
  observer = null
  if (!settings.enabled || !settings.reveal || !mapping.length) {
    unrevealAll()
    return
  }
  scan(document.body)
  refreshHighlights()
  observer = new MutationObserver((muts) => {
    if (!alive()) {
      observer?.disconnect()
      return
    }
    for (const m of muts) {
      if (m.type === 'characterData' && m.target.nodeType === 3) {
        const t = m.target as Text
        // the host app rewrote the text (e.g. streaming): its new text is the new original
        if (touched.has(t) && t.data !== revealed.get(t)) {
          originalText.delete(t)
          touched.delete(t)
        }
      }
    }
    if (pending) return
    pending = window.setTimeout(() => {
      pending = 0
      observer?.disconnect()
      scan(document.body)
      refreshHighlights()
      observer?.observe(document.body, { childList: true, subtree: true, characterData: true })
    }, 250)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

// When the user copies an AI answer while reveal is on, the copy already carries originals.
// When reveal is off, restore placeholders in copied text so pasting elsewhere is useful.
document.addEventListener('copy', (e) => {
  if (!alive() || !settings?.enabled || !mapping.length || settings.reveal) return
  const sel = document.getSelection()?.toString()
  if (!sel) return
  const target = editableFrom(e.target)
  if (target) return // copying from the input box: keep placeholders
  const r = restore(sel, mapping)
  if (r.restored > 0) {
    e.clipboardData?.setData('text/plain', r.text)
    e.preventDefault()
    toast(`<b>가림</b> 복사한 글의 자리표시자 ${r.restored}곳을 원래 값으로 바꿨어요`, [], 3500)
  }
})

// The popup asks whether this tab has the script (tabs opened before install/update do not)
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if ((msg as { type?: string } | null)?.type === 'garim:ping') reply({ ok: true })
})

// ─── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  settings = await getSettings()
  mapping = await getMapping(host)
  // the script starts at document_start (to catch paste first); the UI needs the page body
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }))
  // a copy left behind by a previous version of the extension: replace its UI
  document.querySelectorAll('garim-root').forEach((el) => el.remove())
  document.documentElement.appendChild(rootEl)
  applyReveal()
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return
    if (changes.settings) settings = await getSettings()
    if (changes['map:' + host]) mapping = await getMapping(host)
    applyReveal()
  })
}
void boot()
