import { escapeRe } from './util'
import type { EntityType, MappingEntry } from './types'
import { TYPE_META } from './labels'

export type RestoreSegment =
  | { kind: 'text'; text: string }
  | { kind: 'restored'; text: string; replacement: string; type: EntityType }
  | { kind: 'unknown'; text: string }

export interface RestoreResult {
  text: string
  segments: RestoreSegment[]
  restored: number
  /** Placeholder-looking strings that did not match anything in the mapping. */
  unknown: string[]
  /** Mapping entries that never appeared in the input. */
  missing: MappingEntry[]
}


const OPEN = '[\\[【〔［<(（{]'
const CLOSE = '[\\]】〕］>)）}]'

/** Build a tolerant regex for a placeholder such as "[이름_1]". */
function tokenPattern(label: string, n: string) {
  const l = label
    .split('')
    .map((ch) => escapeRe(ch))
    .join('\\s?')
  // bracketed, with optional spaces / different separators  →  [이름_1] 【이름 1】 (이름-1) [ 이름_1 ]
  const bracketed = `${OPEN}\\s*${l}\\s*[_\\-\\s#]?\\s*${n}\\s*${CLOSE}`
  // bare with underscore  →  이름_1
  const bare = `(?<![\\w가-힣])${l}_${n}(?!\\d)`
  // escaped markdown  →  \[이름_1\]
  const md = `\\\\\\[\\s*${l}\\s*[_\\-]?\\s*${n}\\s*\\\\\\]`
  return `${md}|${bracketed}|${bare}`
}

const digitsFlex = (d: string) => d.split('').join('[\\s.\\-]?')

export function restore(input: string, mapping: MappingEntry[]): RestoreResult {
  const patterns: Array<{ re: string; entry: MappingEntry }> = []
  for (const e of mapping) {
    if (e.mode === 'redact') continue
    if (e.mode === 'token') {
      const m = e.replacement.match(/^\[(.+)_(\d+)\]$/)
      if (m) {
        patterns.push({ re: tokenPattern(m[1], m[2]), entry: e })
        continue
      }
    }
    // fake values (and anything else): exact, plus digit-flexible variant for numeric formats
    const digits = e.replacement.replace(/\D/g, '')
    const numericShape = /^[\d\s.\-+()가]+$/.test(e.replacement) && digits.length >= 7
    patterns.push({
      re: numericShape ? `(?<!\\d)${digitsFlex(digits)}(?!\\d)|${escapeRe(e.replacement)}` : escapeRe(e.replacement),
      entry: e,
    })
  }

  // longest replacement first so "[이름_10]" wins over "[이름_1]" and fake values nest correctly
  patterns.sort((a, b) => b.entry.replacement.length - a.entry.replacement.length)

  const segments: RestoreSegment[] = []
  const found = new Set<MappingEntry>()
  let restored = 0

  if (patterns.length) {
    const combined = new RegExp(patterns.map((p, i) => `(?<g${i}>${p.re})`).join('|'), 'gi')
    let cursor = 0
    let m: RegExpExecArray | null
    while ((m = combined.exec(input)) !== null) {
      if (m[0].length === 0) {
        combined.lastIndex++
        continue
      }
      const groups = m.groups ?? {}
      const idx = patterns.findIndex((_, i) => groups[`g${i}`] !== undefined)
      if (idx < 0) continue
      const entry = patterns[idx].entry
      if (m.index > cursor) segments.push({ kind: 'text', text: input.slice(cursor, m.index) })
      segments.push({ kind: 'restored', text: entry.original, replacement: m[0], type: entry.type })
      found.add(entry)
      restored++
      cursor = m.index + m[0].length
    }
    if (cursor < input.length) segments.push({ kind: 'text', text: input.slice(cursor) })
  } else if (input) {
    segments.push({ kind: 'text', text: input })
  }

  // Flag leftover placeholder-looking tokens (e.g. the AI invented [이름_7])
  const labels = new Set<string>()
  for (const meta of Object.values(TYPE_META)) {
    labels.add(meta.ko)
    labels.add(meta.en)
  }
  for (const e of mapping) if (e.label) labels.add(e.label)
  const labelAlt = [...labels].map(escapeRe).join('|')
  const unknownRe = new RegExp(`${OPEN}\\s*(?:${labelAlt})\\s*[_\\-\\s]?\\s*\\d+\\s*${CLOSE}`, 'g')
  const unknown = new Set<string>()
  const finalSegments: RestoreSegment[] = []
  for (const seg of segments) {
    if (seg.kind !== 'text') {
      finalSegments.push(seg)
      continue
    }
    let c = 0
    let m: RegExpExecArray | null
    unknownRe.lastIndex = 0
    while ((m = unknownRe.exec(seg.text)) !== null) {
      if (m.index > c) finalSegments.push({ kind: 'text', text: seg.text.slice(c, m.index) })
      finalSegments.push({ kind: 'unknown', text: m[0] })
      unknown.add(m[0])
      c = m.index + m[0].length
    }
    if (c < seg.text.length) finalSegments.push({ kind: 'text', text: seg.text.slice(c) })
  }

  return {
    text: finalSegments.map((s) => s.text).join(''),
    segments: finalSegments,
    restored,
    unknown: [...unknown],
    missing: mapping.filter((e) => e.mode !== 'redact' && !found.has(e)),
  }
}
