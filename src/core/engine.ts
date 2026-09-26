import { DETECTORS, TYPE_PRIORITY, detectNamesStrong, type Candidate } from './detectors'
import { isPlausibleName } from './names'
import type { DetectOptions, Entity, EntityType } from './types'
import { digitsOf } from './validators'

export const ALL_TYPES: EntityType[] = [
  'name',
  'rrn',
  'frn',
  'phone',
  'email',
  'address',
  'account',
  'card',
  'birth',
  'bizno',
  'corpno',
  'passport',
  'driver',
  'car',
  'ip',
  'secret',
  'url',
  'custom',
]

export const defaultDetectOptions = (): DetectOptions => ({
  enabled: Object.fromEntries(ALL_TYPES.map((t) => [t, true])) as Record<EntityType, boolean>,
  strongNames: false,
  customTerms: [],
  allowList: [],
})

const CONF_RANK = { high: 3, medium: 2, low: 1 } as const

const NUMERIC_TYPES = new Set<EntityType>(['rrn', 'frn', 'phone', 'card', 'account', 'bizno', 'corpno', 'driver'])

/** Normalised key used to decide whether two values are "the same" piece of information. */
export function normalizeValue(type: EntityType, value: string): string {
  if (NUMERIC_TYPES.has(type)) {
    let d = digitsOf(value)
    if (type === 'phone' && d.startsWith('82')) d = '0' + d.slice(2).replace(/^0/, '')
    return d || value
  }
  if (type === 'email' || type === 'url') return value.trim().toLowerCase()
  return value.trim().replace(/\s+/g, ' ')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function customCandidates(text: string, opts: DetectOptions): Candidate[] {
  const out: Candidate[] = []
  for (const term of opts.customTerms) {
    const t = term.text.trim()
    if (!t) continue
    let re: RegExp
    try {
      re = term.regex ? new RegExp(t, 'gu') : new RegExp(escapeRe(t), /[A-Za-z]/.test(t) ? 'gi' : 'g')
    } catch {
      continue
    }
    let m: RegExpExecArray | null
    let guard = 0
    while ((m = re.exec(text)) !== null && guard++ < 5000) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      out.push({ type: 'custom', start: m.index, end: m.index + m[0].length, confidence: 'high', source: 'dictionary', label: term.label || '가림', note: '내 사전' })
    }
  }
  return out
}

/** Names written right next to strong identifiers ("홍길동 010-1234-5678", CSV rows...). */
function adjacentNames(text: string, anchors: Candidate[]): Candidate[] {
  const out: Candidate[] = []
  const anchorTypes = new Set<EntityType>(['phone', 'email', 'rrn', 'frn', 'account', 'address', 'card'])
  for (const a of anchors) {
    if (!anchorTypes.has(a.type) || a.confidence === 'low') continue
    // preceding word: "홍길동 010-..." / "홍길동, 010-..." / "홍길동(010-...)" / "홍길동\t010"
    const pre = text.slice(Math.max(0, a.start - 12), a.start)
    const pm = pre.match(/(?:^|[^가-힣])([가-힣]{2,4})(?:\s*[,/|\t(（]\s*|\s+)$/)
    if (pm && isPlausibleName(pm[1])) {
      const start = a.start - pm[0].length + pm[0].indexOf(pm[1])
      out.push({ type: 'name', start, end: start + pm[1].length, confidence: 'medium', source: 'context', note: '연락처 옆 이름' })
    }
    // following word: "010-1234-5678 홍길동"
    const post = text.slice(a.end, a.end + 12)
    const fm = post.match(/^(?:\s*[,/|\t)）]\s*|\s+)\(?([가-힣]{3,4})(?![가-힣])/)
    if (fm && isPlausibleName(fm[1])) {
      const start = a.end + fm[0].indexOf(fm[1])
      out.push({ type: 'name', start, end: start + fm[1].length, confidence: 'medium', source: 'context', note: '연락처 옆 이름' })
    }
  }
  return out
}

function resolveOverlaps(cands: Candidate[]): Candidate[] {
  const sorted = [...cands].sort(
    (a, b) =>
      TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type] ||
      CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  )
  const accepted: Candidate[] = []
  for (const c of sorted) {
    if (c.end <= c.start) continue
    const clash = accepted.find((a) => c.start < a.end && a.start < c.end)
    if (!clash) {
      accepted.push(c)
      continue
    }
    // A lower-priority candidate that fully contains a higher one (e.g. address containing a
    // building number) is dropped; a partially overlapping one is dropped as well.
  }
  return accepted.sort((a, b) => a.start - b.start)
}

/** Every other occurrence of an already detected value is masked too. */
function propagate(text: string, accepted: Candidate[]): Candidate[] {
  const extra: Candidate[] = []
  const seen = new Set<string>()
  const taken = (s: number, e: number) =>
    accepted.some((a) => s < a.end && a.start < e) || extra.some((a) => s < a.end && a.start < e)
  for (const c of accepted) {
    const value = text.slice(c.start, c.end)
    const key = c.type + '\u0000' + value
    if (seen.has(key) || value.length < 2) continue
    seen.add(key)
    const re = new RegExp(escapeRe(value), 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const s = m.index
      const e = s + value.length
      if (taken(s, e)) continue
      if (c.type === 'name') {
        // must not be glued to a preceding hangul char (e.g. "이김민수")
        if (/[가-힣]/.test(text[s - 1] ?? '')) continue
      } else if (/^[\dA-Za-z]/.test(value) && /[\dA-Za-z]/.test(text[s - 1] ?? '')) continue
      else if (/[\dA-Za-z]$/.test(value) && /[\dA-Za-z]/.test(text[e] ?? '')) continue
      extra.push({ ...c, start: s, end: e, source: 'propagated', confidence: c.confidence, note: '같은 값 반복' })
    }
  }
  return extra
}

export function detect(text: string, opts: DetectOptions): Entity[] {
  if (!text) return []
  let cands: Candidate[] = []
  for (const [types, fn] of DETECTORS) {
    const list = Array.isArray(types) ? types : [types]
    if (!list.some((t) => opts.enabled[t])) continue
    for (const c of fn(text)) if (opts.enabled[c.type]) cands.push(c)
  }
  if (opts.enabled.name) {
    cands.push(...adjacentNames(text, cands))
    if (opts.strongNames) cands.push(...detectNamesStrong(text))
  }
  if (opts.enabled.custom) cands.push(...customCandidates(text, opts))

  if (opts.allowList.length) {
    const allow = new Set(opts.allowList.map((a) => a.trim().toLowerCase()).filter(Boolean))
    const allowDigits = new Set(opts.allowList.map((a) => digitsOf(a)).filter((d) => d.length >= 6))
    cands = cands.filter((c) => {
      const v = text.slice(c.start, c.end)
      if (allow.has(v.trim().toLowerCase())) return false
      if (NUMERIC_TYPES.has(c.type) && allowDigits.has(digitsOf(v))) return false
      return true
    })
  }

  // "서울특별시 송파구", "성남시 분당구": district names are not people
  cands = cands.filter((c) => {
    if (c.type !== 'name') return true
    const pre = text.slice(Math.max(0, c.start - 8), c.start)
    return !(/(?:특별시|광역시|자치시|자치도|[가-힣]시|[가-힣]도|서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+$/.test(pre) && /[구군시동읍면]$/.test(c.end - c.start ? text.slice(c.end - 1, c.end) : ''))
  })

  const accepted = resolveOverlaps(cands)
  const all = [...accepted, ...propagate(text, accepted)].sort((a, b) => a.start - b.start)
  return all.map((c) => ({
    id: `${c.type}:${c.start}:${c.end}`,
    type: c.type,
    start: c.start,
    end: c.end,
    value: text.slice(c.start, c.end),
    confidence: c.confidence,
    source: c.source,
    note: c.note,
    label: c.label,
  }))
}

/** Add a user-selected range as a manual entity (replaces overlapping detections). */
export function addManual(text: string, entities: Entity[], start: number, end: number, label = '가림'): Entity[] {
  const s = Math.max(0, Math.min(start, end))
  const e = Math.min(text.length, Math.max(start, end))
  if (e <= s) return entities
  const kept = entities.filter((x) => x.end <= s || x.start >= e)
  const manual: Entity = {
    id: `custom:${s}:${e}`,
    type: 'custom',
    start: s,
    end: e,
    value: text.slice(s, e),
    confidence: 'high',
    source: 'manual',
    label,
    note: '직접 선택',
  }
  return [...kept, manual].sort((a, b) => a.start - b.start)
}
