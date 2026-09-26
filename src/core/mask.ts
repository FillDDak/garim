import { normalizeValue } from './engine'
import { tokenLabel } from './labels'
import { fakeName } from './names'
import type { Entity, EntityType, MappingEntry, MaskMode, MaskOptions, MaskResult, OutputSegment } from './types'

const pad = (n: number, w: number) => String(n).padStart(w, '0').slice(-w)
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const letterIndex = (n: number) => {
  let s = ''
  let x = n
  do {
    s = LETTERS[(x - 1) % 26] + s
    x = Math.floor((x - 1) / 26)
  } while (x > 0)
  return s
}

export const entityKey = (type: EntityType, value: string, label?: string) =>
  `${type}${type === 'custom' ? ':' + (label ?? '') : ''}\u0000${normalizeValue(type, value)}`

export function makeToken(type: EntityType, n: number, lang: MaskOptions['tokenLang'], label?: string) {
  return `[${tokenLabel(type, lang, label)}_${n}]`
}

/** Natural-looking but clearly fictional replacement values. */
export function makeFake(type: EntityType, n: number, original: string, label?: string): string {
  switch (type) {
    case 'name':
      return fakeName(n - 1 + (original.length === 2 ? 3 : 0))
    case 'phone':
      return original.startsWith('+82') ? `+82-10-0000-${pad(1000 + n, 4)}` : `010-0000-${pad(1000 + n, 4)}`
    case 'email':
      return `user${n}@example.com`
    case 'rrn':
      return `000101-3${pad(n, 6)}`
    case 'frn':
      return `000101-7${pad(n, 6)}`
    case 'card':
      return `0000-0000-0000-${pad(n, 4)}`
    case 'account':
      return `000-0000-${pad(n, 6)}`
    case 'bizno':
      return `000-00-${pad(n, 5)}`
    case 'corpno':
      return `000000-${pad(n, 7)}`
    case 'passport':
      return `M000${pad(n, 5)}`
    case 'driver':
      return `00-00-000000-${pad(n, 2)}`
    case 'car':
      return `00가${pad(n, 4)}`
    case 'address':
      return `서울특별시 가상구 예시로 ${n}`
    case 'ip':
      return original.includes(':') && !original.includes('.') ? `2001:db8::${n}` : `192.0.2.${n}`
    case 'birth':
      return `2000-01-${pad(((n - 1) % 28) + 1, 2)}`
    case 'secret':
      return `REDACTED_SECRET_${n}`
    case 'url':
      return `https://example.com/link-${n}`
    case 'custom':
      return `${label || '가림'}${letterIndex(n)}`
  }
}

const star = (s: string) => s.replace(/[^\s\-.@()/:]/g, '*')

/** Irreversible partial masking (010-****-5678, 김*수 ...). */
export function makeRedaction(type: EntityType, value: string, partial: boolean): string {
  if (!partial) return '■'.repeat(Math.min(Math.max(value.replace(/\s/g, '').length, 3), 12))
  switch (type) {
    case 'name': {
      if (value.length <= 2) return value[0] + '*'
      return value[0] + '*'.repeat(value.length - 2) + value[value.length - 1]
    }
    case 'phone': {
      const m = value.match(/^(.*?)(\d{3,4})([^\d]*)(\d{4})$/)
      if (m) return m[1] + '*'.repeat(m[2].length) + m[3] + m[4]
      return star(value)
    }
    case 'rrn':
    case 'frn': {
      const m = value.match(/^(\d{6})(\D*)(\d)/)
      return m ? m[1] + m[2] + m[3] + '******' : star(value)
    }
    case 'email': {
      const [local, domain] = value.split('@')
      return (local.length <= 2 ? local[0] + '*' : local.slice(0, 2) + '*'.repeat(Math.min(local.length - 2, 6))) + '@' + domain
    }
    case 'card': {
      let seen = 0
      const total = value.replace(/\D/g, '').length
      return value.replace(/\d/g, (d) => {
        seen++
        return seen <= 4 || seen > total - 4 ? d : '*'
      })
    }
    case 'account': {
      let seen = 0
      const total = value.replace(/\D/g, '').length
      return value.replace(/\d/g, (d) => {
        seen++
        return seen > total - 4 ? d : '*'
      })
    }
    case 'address': {
      const m = value.match(/^(.*?(?:시|군|구)\s)/)
      if (m) {
        // keep up to the district (…구/군/시), hide the rest
        const deep = value.match(/^((?:\S+\s){0,1}\S+(?:시|군|구)\s(?:\S+(?:구)\s)?)/)
        const keep = deep ? deep[1] : m[1]
        return keep + '*'.repeat(Math.min(value.length - keep.length, 10))
      }
      return star(value)
    }
    case 'ip': {
      const parts = value.split('.')
      if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`
      return star(value)
    }
    case 'secret':
      return value.slice(0, Math.min(4, Math.floor(value.length / 4))) + '*'.repeat(Math.min(value.length, 16))
    case 'birth':
      return value.replace(/\d/g, (d, i: number) => (i < 4 && /^\d{4}/.test(value) ? d : '*'))
    case 'car': {
      return value.replace(/\d{4}$/, '****')
    }
    default:
      return star(value)
  }
}

/** Highest index already used for each placeholder label (for consistent numbering). */
function countersFrom(prior: MappingEntry[], mode: MaskMode) {
  const c = new Map<string, number>()
  for (const e of prior) {
    if (e.mode !== mode) continue
    const k = e.type === 'custom' ? 'custom:' + (e.label ?? '') : e.type
    c.set(k, (c.get(k) ?? 0) + 1)
  }
  return c
}

export function applyMask(
  text: string,
  entities: Entity[],
  disabled: ReadonlySet<string>,
  opts: MaskOptions,
  prior: MappingEntry[] = [],
): MaskResult {
  const active = entities.filter((e) => !disabled.has(e.id)).sort((a, b) => a.start - b.start)
  const byKey = new Map<string, MappingEntry>()
  for (const e of prior) if (e.mode === opts.mode) byKey.set(e.key, e)
  const counters = countersFrom(prior, opts.mode)
  const usedReplacements = new Set(prior.filter((e) => e.mode === opts.mode).map((e) => e.replacement))
  const mapping: MappingEntry[] = []
  const usedInThisText = new Set<string>()
  const counts: MaskResult['counts'] = {}
  const segments: OutputSegment[] = []
  const originalsLower = text.toLowerCase()
  let cursor = 0
  let out = ''

  for (const e of active) {
    if (e.start < cursor) continue
    if (e.start > cursor) {
      const chunk = text.slice(cursor, e.start)
      segments.push({ kind: 'text', text: chunk })
      out += chunk
    }
    const key = entityKey(e.type, e.value, e.label)
    let replacement: string
    if (opts.mode === 'redact') {
      replacement = makeRedaction(e.type, e.value, opts.partialRedact)
    } else {
      let entry = byKey.get(key)
      if (!entry) {
        const ck = e.type === 'custom' ? 'custom:' + (e.label ?? '') : e.type
        let n = (counters.get(ck) ?? 0) + 1
        let rep = opts.mode === 'token' ? makeToken(e.type, n, opts.tokenLang, e.label) : makeFake(e.type, n, e.value, e.label)
        // never use a fake value that already appears in the source text
        while ((usedReplacements.has(rep) || (opts.mode === 'fake' && originalsLower.includes(rep.toLowerCase()))) && n < 9999) {
          n++
          rep = opts.mode === 'token' ? makeToken(e.type, n, opts.tokenLang, e.label) : makeFake(e.type, n, e.value, e.label)
        }
        counters.set(ck, n)
        usedReplacements.add(rep)
        entry = { replacement: rep, original: e.value, type: e.type, label: e.label, mode: opts.mode, key }
        byKey.set(key, entry)
      }
      replacement = entry.replacement
      if (!usedInThisText.has(key)) {
        usedInThisText.add(key)
        mapping.push(entry)
      }
    }
    counts[e.type] = (counts[e.type] ?? 0) + 1
    segments.push({ kind: 'mask', text: replacement, entityId: e.id, type: e.type, original: e.value })
    out += replacement
    cursor = e.end
  }
  if (cursor < text.length) {
    const chunk = text.slice(cursor)
    segments.push({ kind: 'text', text: chunk })
    out += chunk
  }
  return { text: out, segments, mapping, counts }
}

/** Merge newly created mapping entries into a session mapping (dedupe by mode+key). */
export function mergeMapping(prior: MappingEntry[], next: MappingEntry[]): MappingEntry[] {
  const seen = new Set(prior.map((e) => e.mode + '\u0001' + e.key))
  const merged = [...prior]
  for (const e of next) {
    const k = e.mode + '\u0001' + e.key
    if (!seen.has(k)) {
      seen.add(k)
      merged.push(e)
    }
  }
  return merged
}

export const AI_NOTICE: Record<'ko' | 'en', string> = {
  ko: '※ 안내: 이 글의 [이름_1]처럼 대괄호로 표시된 부분은 개인정보를 가린 자리표시자입니다. 답변할 때 이 표기를 바꾸거나 추측하지 말고 그대로 사용해 주세요.\n\n',
  en: 'Note: bracketed tokens such as [NAME_1] are privacy placeholders. Keep them exactly as written in your answer and do not guess the hidden values.\n\n',
}
