import { clearMappings, getSettings, setSettings } from './store'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function render() {
  const s = await getSettings()
  $<HTMLInputElement>('enabled').checked = s.enabled
  $<HTMLSelectElement>('mode').value = s.mode
  $<HTMLInputElement>('notice').checked = s.notice
  $<HTMLInputElement>('reveal').checked = s.reveal
  const all = await chrome.storage.local.get(null)
  const maps = Object.entries(all).filter(([k]) => k.startsWith('map:')) as Array<[string, { mapping: unknown[]; updatedAt: number }]>
  const live = maps.filter(([, v]) => Date.now() - v.updatedAt < 86_400_000)
  const total = live.reduce((a, [, v]) => a + v.mapping.length, 0)
  $('stat').innerHTML = total
    ? `복원 키 <b>${total}</b>개 · ${live.map(([k]) => k.slice(4)).join(', ')}<br/>24시간 후 자동 삭제 · 이 브라우저에만 저장`
    : '아직 가린 기록이 없어요. AI 사이트 입력창에 개인정보가 담긴 글을 붙여넣어 보세요.'
}

for (const id of ['enabled', 'notice', 'reveal'] as const) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => setSettings({ [id]: (e.target as HTMLInputElement).checked }))
}
$<HTMLSelectElement>('mode').addEventListener('change', (e) => setSettings({ mode: (e.target as HTMLSelectElement).value as 'token' | 'fake' }))
$('clear').addEventListener('click', async () => {
  await clearMappings()
  await render()
})
/** Is the extension active on the current tab? Tabs opened before install/update need a reload. */
async function checkTab() {
  const el = $('tab')
  const [tab] = (await chrome.tabs?.query({ active: true, currentWindow: true })) ?? []
  if (!tab?.id || !tab.url) return
  const patterns = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.matches ?? [])
  const supported = patterns.some((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(tab.url!))
  el.classList.remove('hidden')
  if (!supported) {
    el.className = 'tab off'
    $('tabText').textContent = '이 사이트는 자동 가림 대상이 아니에요 (ChatGPT·Claude·Gemini 등에서 동작)'
    return
  }
  const ok = await chrome.tabs!.sendMessage(tab.id, { type: 'garim:ping' }).then(
    (r) => Boolean((r as { ok?: boolean } | undefined)?.ok),
    () => false,
  )
  if (ok) {
    el.className = 'tab ok'
    $('tabText').textContent = '✓ 이 탭에서 동작 중이에요'
    return
  }
  el.className = 'tab warn'
  $('tabText').textContent = '이 탭은 새로고침해야 가림이 동작해요'
  const btn = $('reload')
  btn.classList.remove('hidden')
  btn.addEventListener('click', async () => {
    await chrome.tabs!.reload(tab.id!)
    window.close()
  })
}

$('open').addEventListener('click', () => chrome.tabs?.create({ url: 'https://fillddak.github.io/what/' }))
void render()
void checkTab()
