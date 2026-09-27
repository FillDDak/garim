import type { Worker } from 'tesseract.js'
import { detect } from '../core/engine'
import { ID_DOC_RE } from '../core/detectors'
import type { DetectOptions, Entity, EntityType } from '../core/types'
import { assetUrl } from './assetUrl'
import { enhanceForOcr, estimateSkew, rotateCanvas } from './deskew'
import { findDocumentQuad, warpQuad } from './perspective'


export interface OcrProgress {
  status: string
  progress: number
}

let workerPromise: Promise<Worker> | null = null
let progressListener: ((p: OcrProgress) => void) | null = null

const STATUS_KO: Record<string, string> = {
  'loading tesseract core': 'OCR 엔진 불러오는 중',
  'initializing tesseract': 'OCR 엔진 준비 중',
  'initialized tesseract': 'OCR 엔진 준비 완료',
  'loading language traineddata': '한국어·영어 모델 불러오는 중',
  'loading language traineddata (from cache)': '한국어·영어 모델 불러오는 중 (캐시)',
  'initializing api': '인식기 초기화 중',
  'initialized api': '인식기 준비 완료',
  'recognizing text': '글자 인식 중',
}

export function getOcrWorker(onProgress?: (p: OcrProgress) => void): Promise<Worker> {
  progressListener = onProgress ?? null
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker(['kor', 'eng'], 1, {
        workerPath: assetUrl('ocr/worker.min.js'),
        corePath: assetUrl('ocr/core'),
        langPath: assetUrl('ocr/lang'),
        gzip: true,
        cacheMethod: 'write',
        logger: (m: { status: string; progress: number }) => progressListener?.({ status: STATUS_KO[m.status] ?? m.status, progress: m.progress }),
      })
      await worker.setParameters({ preserve_interword_spaces: '1' })
      return worker
    })().catch((err) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

export interface OcrBox {
  x: number
  y: number
  w: number
  h: number
  /** Rotation (radians, clockwise) around the box centre, for text in tilted photos. */
  angle?: number
  /** Exact corners (TL, TR, BR, BL) when the text is rotated or in perspective; x/y/w/h are its bounds. */
  quad?: Array<[number, number]>
}

export interface Detection {
  id: string
  type: EntityType | 'qr' | 'face'
  text: string
  box: OcrBox
  entityId?: string
  label?: string
}

interface Glyph {
  ch: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * OCR an image and return rectangles covering personal information.
 * `source` should be a canvas with the original pixels. Small images are upscaled for accuracy.
 */
export async function detectInImage(
  source: HTMLCanvasElement,
  opts: DetectOptions,
  onProgress?: (p: OcrProgress) => void,
): Promise<{ detections: Detection[]; text: string; entities: Entity[] }> {
  const worker = await getOcrWorker(onProgress)
  progressListener = onProgress ?? null

  // Photos are rarely flat: undo the perspective of a photographed sheet, then any remaining
  // rotation (Tesseract loses most Korean text beyond ~5° of skew). The whole image is always
  // recognised as well, so text outside a detected sheet is never skipped.
  const views: View[] = []
  const quad = findDocumentQuad(source)
  if (quad) {
    const flat = warpQuad(source, quad)
    views.push(straighten(flat.canvas, flat.toSource, source))
  }
  views.push(straighten(source, (x, y) => [x, y], source))

  const detections: Detection[] = []
  let text = ''
  let entities: Entity[] = []
  for (const [i, view] of views.entries()) {
    // with a detected sheet, the whole photo is only a safety net: a lighter, faster pass
    const thorough = !(quad && i > 0)
    const r = await recognizeView(worker, view, opts, thorough)
    if (!entities.length && r.entities.length) {
      text = r.text
      entities = r.entities
    } else if (!text) text = r.text
    for (const d of r.detections) addDetection(detections, d)
    if (view.work !== source) view.work.width = view.work.height = 0
  }
  return { detections, text, entities }
}

interface View {
  /** Canvas to recognise. */
  work: HTMLCanvasElement
  /** Maps a point of `work` back to the original image. */
  toSource: (x: number, y: number) => [number, number]
  /** False when `work` is the untouched original. */
  transformed: boolean
}

function straighten(canvas: HTMLCanvasElement, toSource: View['toSource'], source: HTMLCanvasElement): View {
  const skew = estimateSkew(canvas)
  if (Math.abs(skew) < 1) return { work: canvas, toSource, transformed: canvas !== source }
  const r = rotateCanvas(canvas, skew)
  if (canvas !== source) canvas.width = canvas.height = 0
  return { work: r.canvas, toSource: (x, y) => toSource(...r.toSource(x, y)), transformed: true }
}

async function recognizeView(
  worker: Worker,
  view: View,
  opts: DetectOptions,
  thorough: boolean,
): Promise<{ detections: Detection[]; text: string; entities: Entity[] }> {
  const { work, toSource, transformed } = view
  // Tesseract works best with ~30px glyphs: upscale small screenshots, cap huge photos
  const longSide = Math.max(work.width, work.height)
  let scale = work.width < 1400 ? Math.min(2.5, 2000 / Math.max(1, work.width)) : 1
  const cap = thorough ? 2200 : 1400
  if (longSide * scale > cap) scale = cap / longSide
  let input: HTMLCanvasElement = work
  if (Math.abs(scale - 1) > 0.05) {
    input = document.createElement('canvas')
    input.width = Math.round(work.width * scale)
    input.height = Math.round(work.height * scale)
    const ctx = input.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(work, 0, 0, input.width, input.height)
  }

  // Complementary passes, merged: a sparse pass on plain pixels, a uniform-block pass with Sauvola
  // thresholding (coloured chat bubbles), a pass on the brightest colour channel (black print over
  // coloured arcs/patterns on ID cards), and one with ruled lines removed (scanned forms).
  const passes: Array<{ id: string; canvas: () => HTMLCanvasElement; psm: string; th: string }> = [{ id: 'raw11', canvas: () => input, psm: '11', th: '0' }]
  if (thorough) {
    passes.push({ id: 'sau6', canvas: () => input, psm: '6', th: '2' }, { id: 'sau11', canvas: () => input, psm: '11', th: '2' })
    passes.push({ id: 'max11', canvas: () => channelMax(input), psm: '11', th: '0' })
    const lines = removeRuledLines(input)
    if (lines) passes.push({ id: 'form6', canvas: () => lines, psm: '6', th: '0' })
  }
  const detections: Detection[] = []
  let firstText = ''
  let firstEntities: Entity[] = []
  let idDoc = false
  const collect = (blocks: TBlock[], passId: string, f = 1) => {
    // Word spacing from OCR is unreliable for Korean, so detect on a tight and a loose spacing
    for (const gapRatio of [0.28, 0.6]) {
      const lin = linearize(blocks, gapRatio)
      const text = normalizeOcrText(lin.text)
      debugLog(text)
      const entities = [...detect(text, opts), ...numberRuns(text)]
      if (!firstEntities.length && entities.length) {
        firstText = text
        firstEntities = entities
      } else if (!firstText) firstText = text
      if (ID_DOC_RE.test(text)) idDoc = true
      const found = boxesFor(entities, lin.glyphs)
      // long numbers: grow the box over neighbouring large glyphs on the same line (OCR often
      // garbles part of an embossed card number), and on ID documents cover the holder's name
      // printed on the line above the ID number even when OCR could not read it
      for (const e of entities) {
        // romanised names on cards: OCR often splits off the first letter ("C HO) HYEONGYU")
        if (e.type === 'name' && /^[A-Z]/.test(e.value)) {
          const own = glyphsIn(lin.glyphs, e.start, e.end)
          if (own.length) {
            const g = growAlongLine(lin.glyphs, e.start, e.end, (ch) => /^[A-Z)|(!.,]$/.test(ch)) ?? {
              x: Math.min(...own.map((b) => b.x0)),
              y: Math.min(...own.map((b) => b.y0)),
              w: Math.max(...own.map((b) => b.x1)) - Math.min(...own.map((b) => b.x0)),
              h: Math.max(...own.map((b) => b.y1)) - Math.min(...own.map((b) => b.y0)),
            }
            // plus one letter on the left: a first letter split off by OCR is often lost entirely
            const lh = median(own.map((b) => b.y1 - b.y0))
            found.push({ id: `${e.id}:line`, type: 'name', text: e.value, box: { x: g.x - lh * 0.9, y: g.y, w: g.w + lh * 0.9, h: g.h } })
          }
        }
        if (!e.id.startsWith('num:')) continue
        const grown = growAlongLine(lin.glyphs, e.start, e.end, (ch) => !/[가-힣A-Za-z]/.test(ch))
        if (grown) found.push({ id: `${e.id}:line`, type: 'custom', label: '번호', text: e.value, box: grown })
        const card = extrapolateCardNumber(lin.glyphs, text, e.start, e.end)
        if (card) found.push({ id: `${e.id}:card`, type: 'card', text: `${e.value.trim()} (카드번호 추정)`, box: card })
        // the holder's name sits above an unspaced ID number (student/employee no.), not a card number
        if (idDoc && /^\d{6,12}$/.test(e.value.trim())) {
          const above = lineAbove(lin.glyphs, text, e.start, e.end)
          if (above) found.push({ id: `${e.id}:above`, type: 'name', text: /[가-힣]{2,}/.test(above.text) ? `${above.text} (번호 위 줄)` : '이름으로 보이는 줄 (번호 바로 위)', box: above.box })
        }
      }
      for (const d of found) {
        const box = f === 1 ? d.box : { x: d.box.x * f, y: d.box.y * f, w: d.box.w * f, h: d.box.h * f }
        addDetection(detections, { ...d, box, id: `${passId}g${gapRatio}:${d.id}` })
      }
    }
  }
  for (const pass of passes) {
    const canvas = pass.canvas()
    await worker.setParameters({ tessedit_pageseg_mode: pass.psm, thresholding_method: pass.th } as never)
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true })
    collect(data.blocks ?? [], pass.id)
    if (canvas !== input) canvas.width = canvas.height = 0
  }

  // Blurry / low-contrast photos: retry once on a contrast-stretched, sharpened, larger copy
  if (thorough && detections.length < 3) {
    const enhanced = enhanceForOcr(work, Math.min(2400, cap))
    const k = enhanced.width / work.width
    await worker.setParameters({ tessedit_pageseg_mode: '6', thresholding_method: '2' } as never)
    const { data } = await worker.recognize(enhanced, {}, { blocks: true, text: true })
    // express the boxes in the same space as the other passes
    collect(data.blocks ?? [], 'enh', scale / k)
    enhanced.width = enhanced.height = 0
  }

  // back to source coordinates + padding; boxes found on a straightened/flattened copy become
  // quadrilaterals that follow the text in the original photo
  for (const d of detections) {
    const pad = Math.max(2, d.box.h * 0.18)
    const x0 = (d.box.x - pad) / scale
    const y0 = (d.box.y - pad) / scale
    const x1 = (d.box.x + d.box.w + pad) / scale
    const y1 = (d.box.y + d.box.h + pad) / scale
    if (!transformed) {
      d.box = { x: Math.max(0, x0), y: Math.max(0, y0), w: x1 - Math.max(0, x0), h: y1 - Math.max(0, y0) }
      continue
    }
    const q = [toSource(x0, y0), toSource(x1, y0), toSource(x1, y1), toSource(x0, y1)]
    const xs = q.map((p) => p[0])
    const ys = q.map((p) => p[1])
    const bx = Math.min(...xs)
    const by = Math.min(...ys)
    d.box = { x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by, quad: q }
  }
  if (input !== work) input.width = input.height = 0
  return { detections, text: firstText, entities: firstEntities }
}


/**
 * Fix the usual OCR confusions inside number-like tokens without changing the string length
 * (so glyph positions stay aligned): O/o/D→0, l/I/|/!→1, S→5, B→8, Z→2.
 */
export function normalizeOcrText(text: string): string {
  const map: Record<string, string> = { O: '0', o: '0', D: '0', l: '1', I: '1', '|': '1', '!': '1', S: '5', B: '8', Z: '2' }
  return text.replace(/[0-9OoDlI|!SBZ][0-9OoDlI|!SBZ\s.-]*[0-9OoDlI|!SBZ]/g, (tok) => {
    const digits = (tok.match(/\d/g) ?? []).length
    const letters = (tok.match(/[OoDlI|!SBZ]/g) ?? []).length
    if (digits < 3 || letters > digits / 3) return tok
    return tok.replace(/[OoDlI|!SBZ]/g, (c) => map[c])
  })
}

/**
 * On images, any long run of digits (card, account, student/employee number…) is masked even when
 * OCR garbled a few characters and the strict validators no longer match.
 */
export function numberRuns(text: string): Entity[] {
  const out: Entity[] = []
  const re = /(?<![\dA-Za-z])\d[\d \-–.]{5,30}\d(?![\dA-Za-z])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const v = m[0]
    const digits = v.replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 20) continue
    if (/\s{3,}/.test(v)) continue
    // plain dates are not identifiers
    if (/^(19|20)\d{2}[.\-/ ]\d{1,2}[.\-/ ]\d{1,2}$/.test(v)) continue
    // dates next to a date label ("최초등록일: 2021년 03월 15일" read as digits)
    if (/(일자|날짜|기간|등록일|발급일|발행일|일시|date)\s*[:：]?\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    // a date followed by a time or another short number
    if (v.replace(/(19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/, '').replace(/\D/g, '').length < 6) continue
    // OCR often garbles part of an embossed number ("40 (4 #0 4190 5176"): grow over neighbouring
    // digit-like junk on the same line so the whole number is covered
    const junk = /[\d#*@&%$()'"“”‘’.,:;|!\- ]/
    let start = m.index
    let end = m.index + v.length
    while (start > 0 && junk.test(text[start - 1]) && text[start - 1] !== '\n') start--
    while (end < text.length && junk.test(text[end]) && text[end] !== '\n') end++
    while (start < m.index && /\s/.test(text[start])) start++
    while (end > m.index + v.length && /\s/.test(text[end - 1])) end--
    out.push({ id: `num:${start}:${end}`, type: 'custom', start, end, value: text.slice(start, end).replace(/^[^\d]+|[^\d]+$/g, ''), confidence: 'medium', source: 'rule', label: '번호', note: '긴 번호' })
  }
  return out
}

/** Brightest colour channel: black print stays dark while coloured backgrounds turn light. */
function channelMax(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.max(d[i], d[i + 1], d[i + 2])
  ctx.putImageData(img, 0, 0)
  return c
}

/**
 * Scanned forms: long horizontal/vertical ruled lines confuse Tesseract's layout analysis.
 * Returns a copy with those lines painted white, or null when the image has no ruled lines.
 */
function removeRuledLines(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const w = src.width
  const h = src.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const dark = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) dark[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114 < 110 ? 1 : 0
  const minH = Math.round(w * 0.12)
  const minV = Math.round(h * 0.08)
  const erase = new Uint8Array(w * h)
  let lines = 0
  for (let y = 0; y < h; y++) {
    let run = 0
    for (let x = 0; x <= w; x++) {
      if (x < w && dark[y * w + x]) run++
      else {
        if (run >= minH) {
          lines++
          for (let k = x - run; k < x; k++) erase[y * w + k] = 1
        }
        run = 0
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0
    for (let y = 0; y <= h; y++) {
      if (y < h && dark[y * w + x]) run++
      else {
        if (run >= minV) {
          lines++
          for (let k = y - run; k < y; k++) erase[k * w + x] = 1
        }
        run = 0
      }
    }
  }
  // a handful of pixel rows per ruled line: need several lines before calling it a form
  if (lines < 12) {
    c.width = c.height = 0
    return null
  }
  for (let i = 0; i < w * h; i++) if (erase[i]) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255
  ctx.putImageData(img, 0, 0)
  return c
}

/** Opt-in OCR debugging: set localStorage 'garim:debug' = '1' to collect recognised text on window.__garimOcr. */
function debugLog(text: string) {
  try {
    if (localStorage.getItem('garim:debug') !== '1') return
    const w = window as unknown as { __garimOcr?: string[] }
    ;(w.__garimOcr ??= []).push(text)
  } catch {
    /* ignore */
  }
}

/** QR codes / barcodes often encode personal data (tickets, payment, vaccine passes). */
export async function detectCodes(source: HTMLCanvasElement): Promise<Detection[]> {
  const BD = (window as unknown as { BarcodeDetector?: new (o?: unknown) => { detect: (s: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly; rawValue: string }>> } }).BarcodeDetector
  if (!BD) return []
  try {
    const det = new BD()
    const codes = await det.detect(source)
    return codes.map((c, i) => ({
      id: `qr:${i}`,
      type: 'qr' as const,
      text: c.rawValue ? `QR/바코드: ${c.rawValue.slice(0, 40)}` : 'QR/바코드',
      box: { x: c.boundingBox.x - 4, y: c.boundingBox.y - 4, w: c.boundingBox.width + 8, h: c.boundingBox.height + 8 },
    }))
  } catch {
    return []
  }
}

export const barcodeSupported = () => typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined'

type TBlock = NonNullable<import('tesseract.js').Page['blocks']>[number]

/** Flatten Tesseract blocks into text with a per-character bounding box index. */
function linearize(blocks: TBlock[], gapRatio: number): { text: string; glyphs: Array<Glyph | null> } {
  const glyphs: Array<Glyph | null> = []
  let text = ''
  const push = (s: string, g: Glyph | null) => {
    for (const ch of s) {
      text += ch
      glyphs.push(g && ch !== ' ' ? { ch, bbox: g.bbox } : null)
    }
  }
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const lineH = Math.max(1, line.bbox.y1 - line.bbox.y0)
        let prev: { text: string; x1: number } | null = null
        for (const word of line.words) {
          const wt = word.text.trim()
          if (!wt) continue
          if (prev) {
            // Korean OCR often splits a word into syllables: use the real horizontal gap for spacing
            const gap = word.bbox.x0 - prev.x1
            const glue = /[-.@_/]$/.test(prev.text) || /^[-.@_/]/.test(wt)
            if (!glue && gap > lineH * gapRatio) push(' ', null)
          }
          if (word.symbols?.length) for (const sym of word.symbols) push(sym.text, { ch: sym.text, bbox: sym.bbox })
          else push(wt, { ch: wt, bbox: word.bbox })
          prev = { text: wt, x1: word.bbox.x1 }
        }
        push('\n', null)
      }
    }
    push('\n', null)
  }
  return { text, glyphs }
}

/** One rectangle per visual line for every entity. */
function boxesFor(entities: Entity[], glyphs: Array<Glyph | null>): Detection[] {
  const out: Detection[] = []
  for (const e of entities) {
    let cur: OcrBox | null = null
    const flush = () => {
      if (cur) out.push({ id: `${e.id}:${out.length}`, type: e.type, text: e.value, box: cur, entityId: e.id, label: e.label })
      cur = null
    }
    for (let i = e.start; i < e.end; i++) {
      const g = glyphs[i]
      if (!g) continue
      const b = g.bbox
      // start a new rectangle when the entity wraps onto another visual line
      const cy = (b.y0 + b.y1) / 2
      if (cur && (cy < cur.y - cur.h * 0.2 || cy > cur.y + cur.h * 1.2 || b.x0 < cur.x - cur.h)) flush()
      if (!cur) cur = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }
      else {
        const c: OcrBox = cur
        const x1 = Math.max(c.x + c.w, b.x1)
        const y1 = Math.max(c.y + c.h, b.y1)
        c.x = Math.min(c.x, b.x0)
        c.y = Math.min(c.y, b.y0)
        c.w = x1 - c.x
        c.h = y1 - c.y
      }
    }
    flush()
  }
  return out
}

/** Intersection over the smaller box. */
function overlap(a: OcrBox, b: OcrBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  return inter / Math.max(1, Math.min(a.w * a.h, b.w * b.h))
}

type GBox = Glyph['bbox']

/** Glyph boxes of text[start, end) (skipping spaces). */
function glyphsIn(glyphs: Array<Glyph | null>, start: number, end: number): GBox[] {
  const out: GBox[] = []
  for (let i = start; i < end; i++) if (glyphs[i]) out.push(glyphs[i]!.bbox)
  return out
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/** Extend a number's box over glyphs of similar size chained on the same visual line. */
function growAlongLine(glyphs: Array<Glyph | null>, start: number, end: number, allow: (ch: string) => boolean): OcrBox | null {
  const own = glyphsIn(glyphs, start, end)
  if (!own.length) return null
  const h = median(own.map((b) => b.y1 - b.y0))
  const cy = median(own.map((b) => (b.y0 + b.y1) / 2))
  let x0 = Math.min(...own.map((b) => b.x0))
  let x1 = Math.max(...own.map((b) => b.x1))
  let y0 = Math.min(...own.map((b) => b.y0))
  let y1 = Math.max(...own.map((b) => b.y1))
  const line = glyphs
    .filter((g): g is Glyph => !!g && allow(g.ch) && Math.abs((g.bbox.y0 + g.bbox.y1) / 2 - cy) < h * 0.5 && g.bbox.y1 - g.bbox.y0 > h * 0.55)
    .map((g) => g.bbox)
    .sort((a, b) => a.x0 - b.x0)
  let changed = true
  while (changed) {
    changed = false
    for (const b of line) {
      if (b.x1 <= x0 && x0 - b.x1 < h * 2.2 && b.x0 < x0) {
        x0 = b.x0
        changed = true
      } else if (b.x0 >= x1 && b.x0 - x1 < h * 2.2 && b.x1 > x1) {
        x1 = b.x1
        changed = true
      }
      if (changed) {
        y0 = Math.min(y0, b.y0)
        y1 = Math.max(y1, b.y1)
      }
    }
  }
  const ownX0 = Math.min(...own.map((b) => b.x0))
  const ownX1 = Math.max(...own.map((b) => b.x1))
  if (x0 === ownX0 && x1 === ownX1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * On ID cards the holder's name sits on the line right above the ID number. Returns a box over
 * that line spanning at least the number's width (so an unread first syllable is still covered).
 */
function lineAbove(glyphs: Array<Glyph | null>, text: string, start: number, end: number): { box: OcrBox; text: string } | null {
  const own = glyphsIn(glyphs, start, end)
  if (!own.length) return null
  const h = median(own.map((b) => b.y1 - b.y0))
  const nx0 = Math.min(...own.map((b) => b.x0))
  const nx1 = Math.max(...own.map((b) => b.x1))
  const ny0 = Math.min(...own.map((b) => b.y0))
  // previous text line
  const lineStart = text.lastIndexOf('\n', start - 1)
  if (lineStart <= 0) return null
  const prevStart = text.lastIndexOf('\n', lineStart - 1) + 1
  const prev = text.slice(prevStart, lineStart).trim()
  if (prev.length > 12 || /\d{4,}/.test(prev)) return null
  const pg = glyphsIn(glyphs, prevStart, lineStart).filter((b) => b.x1 > nx0 - h * 3 && b.x0 < nx1 + h * 3 && ny0 - b.y1 < h * 2.5 && b.y1 <= ny0 + h * 0.3)
  // no glyphs recognised: assume a line of the same height just above the number
  const gy0 = pg.length ? Math.min(...pg.map((b) => b.y0)) : ny0 - h * 1.9
  const gy1 = pg.length ? Math.max(...pg.map((b) => b.y1)) : ny0 - h * 0.35
  const gx0 = Math.min(nx0, ...pg.map((b) => b.x0))
  const gx1 = Math.max(nx1, ...pg.map((b) => b.x1))
  if (gy1 - gy0 < h * 0.5 || ny0 - gy1 > h * 2.5) return null
  return { box: { x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0 }, text: prev.replace(/[^가-힣A-Za-z]/g, '') }
}

/**
 * Card numbers are four groups of four digits. When OCR only read the last two or three groups
 * (the first ones are often crossed by card artwork), extend the box by the missing groups using
 * the measured group width and spacing.
 */
function extrapolateCardNumber(glyphs: Array<Glyph | null>, text: string, start: number, end: number): OcrBox | null {
  const value = text.slice(start, end)
  const groups = [...value.matchAll(/\d{4}/g)]
  if (groups.length < 2 || groups.length >= 4) return null
  // the trailing groups must be clean "dddd dddd"
  const tail = value.match(/(\d{4})[ ]+(\d{4})(?:[ ]+(\d{4}))?\s*$/)
  if (!tail) return null
  const lastIdx = start + value.lastIndexOf(tail[tail[3] ? 3 : 2])
  const prevIdx = start + value.lastIndexOf(tail[tail[3] ? 2 : 1], lastIdx - start - 1)
  const g1 = glyphsIn(glyphs, prevIdx, prevIdx + 4)
  const g2 = glyphsIn(glyphs, lastIdx, lastIdx + 4)
  if (g1.length < 3 || g2.length < 3) return null
  const a0 = Math.min(...g1.map((b) => b.x0))
  const a1 = Math.max(...g1.map((b) => b.x1))
  const b0 = Math.min(...g2.map((b) => b.x0))
  const b1 = Math.max(...g2.map((b) => b.x1))
  const pitch = b0 - a0 // group width + gap
  if (pitch <= 0 || pitch > (a1 - a0) * 2.5) return null
  const seen = tail[3] ? 3 : 2
  const missing = 4 - seen
  const all = [...g1, ...g2]
  const y0 = Math.min(...all.map((b) => b.y0))
  const y1 = Math.max(...all.map((b) => b.y1))
  const firstGroupX = (tail[3] ? a0 - pitch : a0) - missing * pitch
  return { x: firstGroupX, y: y0, w: b1 - firstGroupX, h: y1 - y0 }
}

/**
 * Adds a detection unless it duplicates one already found. When the new box is a larger version
 * of an existing one (e.g. a whole card number vs. the part OCR read), it replaces it.
 */
function addDetection(list: Detection[], d: Detection) {
  const area = (b: OcrBox) => b.w * b.h
  for (let i = 0; i < list.length; i++) {
    const x = list[i]
    const o = overlap(x.box, d.box)
    if (o > 0.5 || (x.type === d.type && o > 0.35)) {
      // keep the larger one (only axis-aligned boxes are merged; polygons stay as found)
      const generic = (t: Detection) => t.type === 'custom' && t.label === '번호'
      const bigger = area(d.box) > area(x.box) * 1.15 && !x.box.quad && !d.box.quad
      // keep the larger box, and the more specific type (계좌번호 beats a generic "번호")
      const keep = bigger ? { ...d } : { ...x }
      if (generic(keep) && (!generic(x) || !generic(d))) {
        const specific = generic(x) ? d : x
        keep.type = specific.type
        keep.label = specific.label
        keep.text = specific.text
      }
      list[i] = keep
      return
    }
  }
  list.push(d)
}
