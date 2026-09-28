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

/**
 * One photo takes several recognition passes (orientation check, differently thresholded copies,
 * a flattened and the original view). Tesseract reports 0–100% per pass; this folds them into one
 * overall figure that only moves forward.
 */
const run = { active: false, done: 0, total: 1, shown: 0 }
/** Adds `n` recognition passes to the expected total of the current run. */
const expectPasses = (n: number) => {
  run.total += n
}
const passDone = () => {
  run.done++
}
function report(status: string, progress: number) {
  if (!progressListener) return
  if (run.active && status === 'recognizing text') {
    run.shown = Math.max(run.shown, Math.min(0.99, (run.done + progress) / Math.max(1, run.total)))
    progressListener({ status: STATUS_KO[status], progress: run.shown })
  } else progressListener({ status: STATUS_KO[status] ?? status, progress })
}

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
        logger: (m: { status: string; progress: number }) => report(m.status, m.progress),
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
): Promise<{ detections: Detection[]; text: string; entities: Entity[]; orientation: number }> {
  const worker = await getOcrWorker(onProgress)
  progressListener = onProgress ?? null
  // expected: orientation check + 5 thorough passes + 1 safety-net pass (adjusted as we go)
  Object.assign(run, { active: true, done: 0, total: 7, shown: 0 })
  try {
    return await detectAll(worker, source, opts)
  } finally {
    run.active = false
  }
}

async function detectAll(
  worker: Worker,
  source: HTMLCanvasElement,
  opts: DetectOptions,
): Promise<{ detections: Detection[]; text: string; entities: Entity[]; orientation: number }> {

  // Photos are rarely flat: undo the perspective of a photographed sheet, then any remaining
  // rotation (Tesseract loses most Korean text beyond ~5° of skew). The whole image is always
  // recognised as well, so text outside a detected sheet is never skipped.
  const views: View[] = []
  // sideways / upside-down photos without EXIF orientation: turn them upright first
  const angle = await detectOrientation(worker, source)
  const base = angle ? rotateCanvas(source, angle) : { canvas: source, toSource: (x: number, y: number): [number, number] => [x, y] }
  const quad = findDocumentQuad(base.canvas)
  if (quad) {
    const flat = warpQuad(base.canvas, quad)
    views.push(straighten(flat.canvas, (x, y) => base.toSource(...flat.toSource(x, y)), source))
  }
  views.push(straighten(base.canvas, base.toSource, source))
  if (!quad) expectPasses(-1)

  const detections: Detection[] = []
  let text = ''
  let entities: Entity[] = []
  let quadWeak = false
  const hint = { idDoc: false }
  for (const [i, view] of views.entries()) {
    // with a detected sheet, the whole photo is only a safety net (a lighter, faster pass) unless
    // the sheet view read little: the outline found may not be the document at all
    const thorough = !(quad && i > 0) || quadWeak
    if (quad && i > 0 && quadWeak) expectPasses(4)
    const r = await recognizeView(worker, view, opts, thorough, hint)
    if (quad && i === 0) quadWeak = r.detections.filter((d) => !(d.type === 'custom' && d.label === '번호')).length < 2
    if (!entities.length && r.entities.length) {
      text = r.text
      entities = r.entities
    } else if (!text) text = r.text
    for (const d of r.detections) addDetection(detections, d)
    if (view.work !== source) view.work.width = view.work.height = 0
  }
  return { detections, text, entities, orientation: angle }
}

/**
 * Photos taken sideways or upside down (and stripped of EXIF orientation) are unreadable for
 * Tesseract. Returns the rotation (degrees) under which a quick OCR pass reads the most confident
 * words; 0 unless another orientation is clearly better.
 */
async function detectOrientation(worker: Worker, source: HTMLCanvasElement): Promise<number> {
  const s = Math.min(1, 1200 / Math.max(source.width, source.height))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(source.width * s))
  small.height = Math.max(1, Math.round(source.height * s))
  small.getContext('2d')!.drawImage(source, 0, 0, small.width, small.height)
  await worker.setParameters({ tessedit_pageseg_mode: '11', thresholding_method: '0' } as never)
  const score = async (c: HTMLCanvasElement) => {
    const { data } = await worker.recognize(c, {}, { blocks: true })
    passDone()
    let n = 0
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const w of l.words) {
            const t = w.text.trim()
            if (w.confidence >= 75 && /^[가-힣A-Za-z0-9]{2,}$/.test(t)) n += t.length
          }
    return n
  }
  try {
    const s0 = await score(small)
    debugLog(`ORIENT 0=${s0}`)
    if (s0 >= 30) return 0
    let best = 0
    let bestScore = s0
    expectPasses(3)
    for (const a of [90, 270, 180]) {
      const r = rotateCanvas(small, a)
      const v = await score(r.canvas)
      r.canvas.width = r.canvas.height = 0
      debugLog(`ORIENT ${a}=${v}`)
      if (v > bestScore) {
        best = a
        bestScore = v
      }
    }
    return bestScore >= Math.max(s0 * 1.6, s0 + 10) ? best : 0
  } finally {
    small.width = small.height = 0
  }
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
  /** Shared between the views of one photo: whether any of them read an ID-document title. */
  hint: { idDoc: boolean },
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
  // the plan assumed 5 passes for a thorough view and 1 for a light one
  expectPasses(passes.length - (thorough ? 5 : 1))
  const detections: Detection[] = []
  let firstText = ''
  let firstEntities: Entity[] = []
  let idDoc = hint.idDoc
  const collect = (blocks: TBlock[], passId: string, f = 1) => {
    // Word spacing from OCR is unreliable for Korean, so detect on a tight and a loose spacing
    for (const gapRatio of [0.28, 0.6]) {
      const lin = linearize(blocks, gapRatio)
      const text = normalizeOcrText(lin.text)
      debugLog(text)
      if (ID_DOC_RE.test(text)) idDoc = hint.idDoc = true
      const entities = [...detect(text, idDoc ? { ...opts, idDocument: true } : opts), ...numberRuns(text)]
      if (!firstEntities.length && entities.length) {
        firstText = text
        firstEntities = entities
      } else if (!firstText) firstText = text
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
            // plus one letter on the left: a first letter split off by OCR is often lost entirely;
            // a given name read alone ("HYEONGYU") lost its whole surname, so cover a surname's width
            const lh = median(own.map((b) => b.y1 - b.y0))
            const lead = lh * (/\s/.test(e.value.trim()) ? 0.9 : 3.4)
            found.push({ id: `${e.id}:line`, type: 'name', text: e.value, box: { x: g.x - lead, y: g.y, w: g.w + lead, h: g.h } })
          }
        }
        if (!e.id.startsWith('num:')) continue
        const grown = growAlongLine(lin.glyphs, e.start, e.end, (ch) => /^[\d#*@&%$|!]$/.test(ch))
        if (grown) found.push({ id: `${e.id}:line`, type: 'custom', label: '번호', text: e.value, box: grown })
        const card = extrapolateCardNumber(lin.glyphs, text, e.start, e.end)
        if (card) found.push({ id: `${e.id}:card`, type: 'card', text: `${e.value.trim()} (카드번호 추정)`, box: card })
        // the holder's name sits above an unspaced ID number (student/employee no.), not a card number
        const lineStart = text.lastIndexOf('\n', e.start - 1) + 1
        const lineEnd = text.indexOf('\n', e.end)
        const lineDigits = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\D/g, '').length
        if (idDoc && /^\d{6,12}$/.test(e.value.trim()) && lineDigits <= 12 && !hasGroupGaps(lin.glyphs, e.start, e.end)) {
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
    passDone()
    collect(data.blocks ?? [], pass.id)
    if (canvas !== input) canvas.width = canvas.height = 0
  }

  // Blurry / low-contrast photos: retry once on a contrast-stretched, sharpened, larger copy
  if (thorough && detections.length < 3) {
    const enhanced = enhanceForOcr(work, Math.min(2400, cap))
    const k = enhanced.width / work.width
    await worker.setParameters({ tessedit_pageseg_mode: '6', thresholding_method: '2' } as never)
    expectPasses(1)
    const { data } = await worker.recognize(enhanced, {}, { blocks: true, text: true })
    passDone()
    // express the boxes in the same space as the other passes
    collect(data.blocks ?? [], 'enh', scale / k)
    enhanced.width = enhanced.height = 0
  }

  // Snap every text box to the ink actually present in the image, so redactions are as tight as
  // the text (OCR glyph boxes are loose and sometimes wildly off)
  const gray = grayOf(input)
  for (const d of detections) {
    if (d.type === 'face' || d.type === 'qr') continue
    const before = d.box
    d.box = tightenToInk(gray, input.width, input.height, d.box)
    debugLog(`TIGHT ${d.type} ${d.text} ${JSON.stringify([before.x, before.y, before.w, before.h].map(Math.round))} -> ${JSON.stringify([d.box.x, d.box.y, d.box.w, d.box.h].map(Math.round))} scale=${scale.toFixed(2)} in=${input.width}x${input.height}`)
  }

  // drop slivers: a box far thinner than the other text boxes is a misaligned OCR fragment
  const textH = median(detections.filter((d) => d.type !== 'face' && d.type !== 'qr').map((d) => d.box.h))
  for (let i = detections.length - 1; i >= 0; i--) {
    const d = detections[i]
    if (d.type === 'face' || d.type === 'qr') continue
    if (d.box.h < Math.max(4, textH * 0.35)) detections.splice(i, 1)
  }

  // back to source coordinates + padding; boxes found on a straightened/flattened copy become
  // quadrilaterals that follow the text in the original photo
  for (const d of detections) {
    const pad = Math.max(1.5, d.box.h * 0.08)
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
    // but never end on punctuation or space (the ':' of "연락처: 010…", a closing bracket)
    const edge = /[\s()'"“”‘’.,:;-]/
    while (start < m.index && edge.test(text[start])) start++
    while (end > m.index + v.length && edge.test(text[end - 1])) end--
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
          // LSTM symbol boxes are fine horizontally but often drift vertically: take the height
          // from the word box, which Tesseract measures reliably
          if (word.symbols?.length)
            for (const sym of word.symbols) {
              const x0 = Math.max(word.bbox.x0, Math.min(sym.bbox.x0, word.bbox.x1))
              const x1 = Math.max(x0 + 1, Math.min(sym.bbox.x1, word.bbox.x1))
              push(sym.text, { ch: sym.text, bbox: { x0, x1, y0: word.bbox.y0, y1: word.bbox.y1 } })
            }
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
    // punctuation at either end ("300,", "김서준)", ": 010…") is not part of the value
    let s0 = e.start
    let s1 = e.end
    const edge = (i: number) => !glyphs[i] || /^[,.:;()[\]{}'"“”‘’·]$/.test(glyphs[i]!.ch)
    while (s0 < s1 - 1 && edge(s0)) s0++
    while (s1 - 1 > s0 && edge(s1 - 1)) s1--
    // split the entity's glyphs into visual lines
    const lines: Glyph[][] = []
    let cur: Glyph[] = []
    let ref: GBox | null = null
    for (let i = s0; i < s1; i++) {
      const g = glyphs[i]
      if (!g) continue
      const b = g.bbox
      const cy = (b.y0 + b.y1) / 2
      if (ref) {
        const rh = ref.y1 - ref.y0
        if (cy < ref.y0 - rh * 0.2 || cy > ref.y1 + rh * 0.2 || b.x0 < ref.x0 - rh) {
          lines.push(cur)
          cur = []
        }
      }
      cur.push(g)
      ref = b
    }
    if (cur.length) lines.push(cur)
    // …and at the ends of every line of a value that wraps ("…올림픽로 300," / "롯데캐슬…")
    const punct = (g: Glyph) => /^[,.:;()[\]{}'"“”‘’·]$/.test(g.ch)
    for (const l of lines) {
      while (l.length > 1 && punct(l[0])) l.shift()
      while (l.length > 1 && punct(l[l.length - 1])) l.pop()
    }
    for (const line of lines) {
      const box = robustBounds(line.map((g) => g.bbox))
      if (box) out.push({ id: `${e.id}:${out.length}`, type: e.type, text: e.value, box, entityId: e.id, label: e.label })
    }
  }
  return out
}

/**
 * Bounds of a line of glyphs ignoring OCR outliers: a misread glyph often comes back with a box
 * two or three lines tall, which used to stretch the whole redaction.
 */
function robustBounds(line: GBox[]): OcrBox | null {
  if (!line.length) return null
  const hs = line.map((b) => b.y1 - b.y0)
  const hMed = median(hs)
  const cyMed = median(line.map((b) => (b.y0 + b.y1) / 2))
  let kept = line.filter((b) => {
    const h = b.y1 - b.y0
    const cy = (b.y0 + b.y1) / 2
    return h <= hMed * 1.7 && Math.abs(cy - cyMed) <= hMed * 0.6
  })
  if (!kept.length) kept = line
  // punctuation (-, ., ,) has tiny boxes: it may extend the width but not define the height
  const tall = kept.filter((b) => b.y1 - b.y0 >= hMed * 0.45)
  const vert = tall.length ? tall : kept
  const x0 = Math.min(...kept.map((b) => b.x0))
  const x1 = Math.max(...kept.map((b) => b.x1))
  const y0 = Math.min(...vert.map((b) => b.y0))
  const y1 = Math.max(...vert.map((b) => b.y1))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
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

/** True when the digits are printed in spaced groups (card numbers), judged from glyph positions. */
function hasGroupGaps(glyphs: Array<Glyph | null>, start: number, end: number): boolean {
  const own = glyphsIn(glyphs, start, end).sort((a, b) => a.x0 - b.x0)
  if (own.length < 2) return false
  const h = median(own.map((b) => b.y1 - b.y0))
  for (let i = 1; i < own.length; i++) if (own[i].x0 - own[i - 1].x1 > h * 0.45) return true
  return false
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
  const generic = (t: Detection) => t.type === 'custom' && t.label === '번호'
  // keep the more specific type (계좌번호 beats a generic "번호")
  const withType = (keep: Detection, x: Detection) => {
    if (generic(keep) && (!generic(x) || !generic(d))) {
      const specific = generic(x) ? d : x
      return { ...keep, type: specific.type, label: specific.label, text: specific.text }
    }
    return keep
  }
  for (let i = 0; i < list.length; i++) {
    const x = list[i]
    const o = overlap(x.box, d.box)
    if (!(o > 0.5 || (x.type === d.type && o > 0.35))) continue
    if (x.box.quad || d.box.quad || x.type === 'face' || d.type === 'face') {
      // polygons (found on a straightened/flattened copy) cannot be unioned: keep whichever
      // contains the other, and keep both when neither does, so nothing is left uncovered
      if (covers(x.box, d.box)) {
        list[i] = withType(x, x)
        return
      }
      if (covers(d.box, x.box)) {
        list[i] = withType({ ...d }, x)
        return
      }
      // the same text seen from two views, one reaching further: one box over both
      const u = x.type !== 'face' && d.type !== 'face' && (x.type === d.type || generic(x) || generic(d)) ? unionQuad(x.box, d.box) : null
      if (u) {
        list[i] = withType({ ...x, box: u }, x)
        return
      }
      continue
    }
    // a specific, validated value (phone, account…) keeps its own box: the generic long-number
    // run around it tends to include neighbouring junk (a colon, a misread bank name)
    if (generic(x) !== generic(d)) {
      list[i] = generic(x) ? { ...d } : x
      return
    }
    const keep = area(d.box) > area(x.box) * 1.15 ? { ...d } : { ...x }
    // same text found twice: cover both horizontally, but keep the tighter vertical extent
    const a = x.box
    const b = d.box
    const xl = Math.min(a.x, b.x)
    const xr = Math.max(a.x + a.w, b.x + b.w)
    const yt = Math.max(a.y, b.y)
    const yb = Math.min(a.y + a.h, b.y + b.h)
    const tighter = a.h <= b.h ? a : b
    keep.box = yb - yt >= tighter.h * 0.7 ? { x: xl, y: yt, w: xr - xl, h: yb - yt } : { x: xl, y: tighter.y, w: xr - xl, h: tighter.h }
    list[i] = withType(keep, x)
    return
  }
  list.push(d)
}

const cornersOf = (b: OcrBox): Array<[number, number]> =>
  b.quad ?? [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ]

/** True when every corner of `inner` lies inside `outer` (within a small tolerance). */
export function covers(outer: OcrBox, inner: OcrBox): boolean {
  const poly = cornersOf(outer)
  const side = Math.min(...poly.map((p, i) => Math.hypot(p[0] - poly[(i + 1) % 4][0], p[1] - poly[(i + 1) % 4][1])))
  const tol = side * 0.3
  return cornersOf(inner).every((p) => pointInPoly(p, poly) || poly.some((a, i) => segDist(p, a, poly[(i + 1) % 4]) <= tol))
}

/**
 * Smallest box in `a`'s own (possibly rotated/sheared) frame that contains both boxes, when the
 * two are nearly parallel; null otherwise.
 */
export function unionQuad(a: OcrBox, b: OcrBox): OcrBox | null {
  const A = cornersOf(a)
  const B = cornersOf(b)
  const o = A[0]
  const u: [number, number] = [A[1][0] - o[0], A[1][1] - o[1]]
  const v: [number, number] = [A[3][0] - o[0], A[3][1] - o[1]]
  const bu: [number, number] = [B[1][0] - B[0][0], B[1][1] - B[0][1]]
  const cross = (p: [number, number], q: [number, number]) => p[0] * q[1] - p[1] * q[0]
  const len = (p: [number, number]) => Math.hypot(p[0], p[1])
  if (Math.abs(cross(u, bu)) / Math.max(1e-9, len(u) * len(bu)) > Math.sin((5 * Math.PI) / 180)) return null
  const det = cross(u, v)
  if (Math.abs(det) < 1e-9) return null
  // coordinates of every corner in the (u, v) frame
  const frame = (pts: Array<[number, number]>) => {
    const ss = pts.map(([px, py]) => cross([px - o[0], py - o[1]], v) / det)
    const ts = pts.map(([px, py]) => cross(u, [px - o[0], py - o[1]]) / det)
    return { s0: Math.min(...ss), s1: Math.max(...ss), t0: Math.min(...ts), t1: Math.max(...ts) }
  }
  const fa = frame(A)
  const fb = frame(B)
  // only boxes on the same text line: their vertical extents must largely coincide
  const common = Math.min(fa.t1, fb.t1) - Math.max(fa.t0, fb.t0)
  if (common < 0.6 * Math.min(fa.t1 - fa.t0, fb.t1 - fb.t0)) return null
  const s0 = Math.min(fa.s0, fb.s0)
  const s1 = Math.max(fa.s1, fb.s1)
  const t0 = Math.min(fa.t0, fb.t0)
  const t1 = Math.max(fa.t1, fb.t1)
  const at = (s: number, t: number): [number, number] => [o[0] + s * u[0] + t * v[0], o[1] + s * u[1] + t * v[1]]
  const quad = [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)]
  const xs = quad.map((p) => p[0])
  const ys = quad.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, quad }
}

function pointInPoly([x, y]: [number, number], poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function segDist([px, py]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(1e-9, dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Ink-oriented grayscale copy of a canvas (0–255). */
function grayOf(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const g = new Uint8Array(canvas.width * canvas.height)
  // brightest channel: black print stays dark, coloured artwork (arcs, stamps, highlights) turns light
  for (let i = 0; i < g.length; i++) g[i] = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
  return g
}

/**
 * Shrinks (or slightly grows) a text box to the ink inside it: rows and columns are kept while
 * they contain text pixels, starting from the box core, so neighbouring lines, table rules and
 * empty padding are excluded while no glyph pixel is left uncovered.
 */
export function tightenToInk(gray: Uint8Array, W: number, H: number, box: OcrBox): OcrBox {
  const h0 = Math.max(4, box.h)
  const m = Math.round(h0 * 0.35)
  const bx0 = Math.max(0, Math.floor(box.x))
  const by0 = Math.max(0, Math.floor(box.y))
  const bx1 = Math.min(W, Math.ceil(box.x + box.w))
  const by1 = Math.min(H, Math.ceil(box.y + box.h))
  if (bx1 - bx0 < 3 || by1 - by0 < 3) return box
  const rx0 = Math.max(0, bx0 - m)
  const ry0 = Math.max(0, by0 - m)
  const rx1 = Math.min(W, bx1 + m)
  const ry1 = Math.min(H, by1 + m)

  // Otsu threshold inside the box; the minority class is the ink (dark text or light text)
  const hist = new Uint32Array(256)
  let n = 0
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
    hist[gray[y * W + x]]++
    n++
  }
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let t = 127
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      t = i
    }
  }
  let dark = 0
  for (let i = 0; i <= t; i++) dark += hist[i]
  const inkIsDark = dark <= n / 2
  // too little contrast to say anything: keep the OCR box
  let lo = 0
  let hi = 0
  for (let i = 0; i < 256; i++) if (hist[i]) { lo = i; break }
  for (let i = 255; i >= 0; i--) if (hist[i]) { hi = i; break }
  if (hi - lo < 40) return box
  const isInk = (v: number) => (inkIsDark ? v <= t : v > t)

  // row profile over the box's columns
  const rows = new Float32Array(ry1 - ry0)
  for (let y = ry0; y < ry1; y++) {
    let c = 0
    for (let x = bx0; x < bx1; x++) if (isInk(gray[y * W + x])) c++
    rows[y - ry0] = c / (bx1 - bx0)
  }
  // a row belongs to the text if it carries a fair share of the densest text row's ink (thin
  // background artwork crossing the box only adds a little) and is not a solid rule/band
  let peak = 0
  for (let y = by0 - ry0; y < by1 - ry0; y++) if (rows[y] < 0.9 && rows[y] > peak) peak = rows[y]
  const floor = Math.max(0.015, peak * 0.22)
  const inked = (r: number) => r >= floor && r < 0.9
  // seed at the inked row closest to the OCR box centre (OCR gets the centre right even when
  // its box is too tall), then grow while rows stay inked – but never far outside the box
  const cy = Math.round((by0 + by1) / 2) - ry0
  let seed = -1
  for (let d = 0; d <= (by1 - by0) / 2; d++) {
    if (cy - d >= 0 && inked(rows[cy - d])) {
      seed = cy - d
      break
    }
    if (cy + d < rows.length && inked(rows[cy + d])) {
      seed = cy + d
      break
    }
  }
  if (seed < 0) return box
  const gap = Math.max(1, Math.round(h0 * 0.12))
  const minTop = Math.max(0, by0 - ry0 - Math.round(h0 * 0.12))
  const maxBottom = Math.min(rows.length - 1, by1 - ry0 - 1 + Math.round(h0 * 0.12))
  let top = seed
  let bottom = seed
  for (let y = seed, miss = 0; y >= minTop && miss <= gap; y--) {
    if (inked(rows[y])) {
      top = y
      miss = 0
    } else miss++
  }
  for (let y = seed, miss = 0; y <= maxBottom && miss <= gap; y++) {
    if (inked(rows[y])) {
      bottom = y
      miss = 0
    } else miss++
  }
  // the result must still contain the middle of the OCR box: never slide off the text
  const core0 = cy - Math.round(h0 * 0.15)
  const core1 = cy + Math.round(h0 * 0.15)
  top = Math.min(top, Math.max(0, core0))
  bottom = Math.max(bottom, Math.min(rows.length - 1, core1))
  const ty0 = ry0 + top
  const ty1 = ry0 + bottom + 1
  if (ty1 - ty0 < h0 * 0.3) return box

  // column profile inside the text band
  const cols = new Uint16Array(rx1 - rx0)
  for (let x = rx0; x < rx1; x++) {
    let c = 0
    for (let y = ty0; y < ty1; y++) if (isInk(gray[y * W + x])) c++
    cols[x - rx0] = c
  }
  const colInked = (x: number) => cols[x] > 0 && cols[x] < (ty1 - ty0) * 0.95
  // first/last inked columns inside the original box, then extend through touching ink
  let left = -1
  let right = -1
  for (let x = bx0 - rx0; x < bx1 - rx0; x++) if (colInked(x)) {
    if (left < 0) left = x
    right = x
  }
  if (left < 0) return box
  // sideways only through ink that touches the box edge (a glyph the OCR box cut through),
  // never across a gap: the next character or a colon/bracket stays outside
  const cgap = 0
  const minLeft = Math.max(0, bx0 - rx0 - Math.round(h0 * 0.2))
  const maxRight = Math.min(cols.length - 1, bx1 - rx0 - 1 + Math.round(h0 * 0.2))
  for (let x = left - 1, miss = 0; x >= minLeft && miss <= cgap; x--) {
    if (colInked(x)) {
      left = x
      miss = 0
    } else miss++
  }
  for (let x = right + 1, miss = 0; x <= maxRight && miss <= cgap; x++) {
    if (colInked(x)) {
      right = x
      miss = 0
    } else miss++
  }
  return { x: rx0 + left, y: ty0, w: right - left + 1, h: ty1 - ty0 }
}
