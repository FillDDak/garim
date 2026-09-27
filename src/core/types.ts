export type EntityType =
  | 'rrn'
  | 'frn'
  | 'phone'
  | 'email'
  | 'card'
  | 'account'
  | 'bizno'
  | 'corpno'
  | 'passport'
  | 'driver'
  | 'car'
  | 'address'
  | 'ip'
  | 'name'
  | 'birth'
  | 'secret'
  | 'url'
  | 'custom'

export type Confidence = 'high' | 'medium' | 'low'

export type EntitySource = 'rule' | 'context' | 'propagated' | 'dictionary' | 'manual'

export interface Entity {
  /** Stable id derived from position + type (unique within one detection pass). */
  id: string
  type: EntityType
  start: number
  end: number
  value: string
  confidence: Confidence
  source: EntitySource
  /** Human readable reason (e.g. "체크섬 검증됨"). */
  note?: string
  /** Custom label (for dictionary entries such as "회사"). */
  label?: string
}

export type MaskMode = 'token' | 'fake' | 'redact'

export type TokenLang = 'ko' | 'en'

export interface CustomTerm {
  id: string
  /** Literal text to always mask (case-insensitive for latin text). */
  text: string
  /** Label used in placeholder, e.g. 회사 → [회사_1] */
  label: string
  /** Treat `text` as a regular expression. */
  regex?: boolean
}

export interface DetectOptions {
  enabled: Record<EntityType, boolean>
  /** Aggressive name guessing (surname + 2 syllables + particle). */
  strongNames: boolean
  customTerms: CustomTerm[]
  /** Values that should never be masked. */
  allowList: string[]
  /** The text is known to come from an ID document (e.g. another OCR view of the same photo). */
  idDocument?: boolean
}

export interface MaskOptions {
  mode: MaskMode
  tokenLang: TokenLang
  /** In redact mode, keep a readable portion (010-****-5678) instead of full blackout. */
  partialRedact: boolean
}

export interface MappingEntry {
  /** Placeholder or fake value that appears in the masked text. */
  replacement: string
  mode: MaskMode
  /** type + normalised original, used to keep replacements consistent. */
  key: string
  original: string
  type: EntityType
  label?: string
}

export interface MaskResult {
  text: string
  /** Segments of the output for rich rendering. */
  segments: OutputSegment[]
  mapping: MappingEntry[]
  counts: Partial<Record<EntityType, number>>
}

export type OutputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mask'; text: string; entityId: string; type: EntityType; original: string }
