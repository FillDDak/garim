import type { Worker } from 'tesseract.js'
import { detect } from '../core/engine'
import type { DetectOptions, Entity, EntityType } from '../core/types'
import { assetUrl } from './assetUrl'
import { enhanceForOcr, estimateSkew, rotateCanvas } from './deskew'


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

  // Photos are rarely straight: Tesseract loses most Korean text beyond ~5° of skew,
  // so estimate the angle and recognise on a straightened copy.
  const skew = estimateSkew(source)
  let work: HTMLCanvasElement = source
  let toSource = (x: number, y: number): [number, number] => [x, y]
  if (Math.abs(skew) >= 1) {
    const r = rotateCanvas(source, skew)
    work = r.canvas
    toSource = r.toSource
  }

  // upscale small screenshots: Tesseract works best with ~30px glyphs
  const scale = work.width < 1400 ? Math.min(2.5, 2000 / Math.max(1, work.width)) : 1
  let input: HTMLCanvasElement = work
  if (scale > 1.05) {
    input = document.createElement('canvas')
    input.width = Math.round(work.width * scale)
    input.height = Math.round(work.height * scale)
    const ctx = input.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(work, 0, 0, input.width, input.height)
  }

  // Two complementary passes: a uniform-block pass keeps sentences in reading order, a sparse pass
  // picks up text in scattered UI elements (chat bubbles, badges). Sauvola adaptive thresholding
  // handles coloured backgrounds such as yellow chat bubbles.
  const passes: string[] = ['6', '11']
  const detections: Detection[] = []
  let firstText = ''
  let firstEntities: Entity[] = []
  for (const psm of passes) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, thresholding_method: '2' } as never)
    const { data } = await worker.recognize(input, {}, { blocks: true, text: true })
    // Word spacing from OCR is unreliable for Korean, so detect on a tight and a loose spacing
    for (const gapRatio of [0.28, 0.6]) {
      const { text, glyphs } = linearize(data.blocks ?? [], gapRatio)
      const entities = detect(text, opts)
      if (!firstText) {
        firstText = text
        firstEntities = entities
      }
      for (const d of boxesFor(entities, glyphs)) {
        const dup = detections.some((x) => x.type === d.type && overlap(x.box, d.box) > 0.35)
        if (!dup) detections.push({ ...d, id: `p${psm}g${gapRatio}:${d.id}` })
      }
    }
  }

  // Blurry / low-contrast photos: retry once on a contrast-stretched, sharpened, larger copy
  if (detections.length < 3) {
    const enhanced = enhanceForOcr(work)
    const k = enhanced.width / work.width
    await worker.setParameters({ tessedit_pageseg_mode: '6', thresholding_method: '2' } as never)
    const { data } = await worker.recognize(enhanced, {}, { blocks: true, text: true })
    for (const gapRatio of [0.28, 0.6]) {
      const { text, glyphs } = linearize(data.blocks ?? [], gapRatio)
      const entities = detect(text, opts)
      if (!firstEntities.length && entities.length) {
        firstText = text
        firstEntities = entities
      }
      for (const d of boxesFor(entities, glyphs)) {
        // express the box in the same (upscaled) space as the other passes
        const f = scale / k
        const box = { x: d.box.x * f, y: d.box.y * f, w: d.box.w * f, h: d.box.h * f }
        if (!detections.some((x) => x.type === d.type && overlap(x.box, box) > 0.35)) detections.push({ ...d, box, id: `enh${gapRatio}:${d.id}` })
      }
    }
    enhanced.width = enhanced.height = 0
  }

  // back to source coordinates + padding (rotated boxes keep the text angle)
  const angle = work === source ? 0 : (skew * Math.PI) / 180
  for (const d of detections) {
    const pad = Math.max(2, d.box.h * 0.18)
    const w = (d.box.w + pad * 2) / scale
    const h = (d.box.h + pad * 2) / scale
    const [cx, cy] = toSource((d.box.x + d.box.w / 2) / scale, (d.box.y + d.box.h / 2) / scale)
    d.box = angle ? { x: cx - w / 2, y: cy - h / 2, w, h, angle } : { x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h }
  }
  if (input !== source) input.width = input.height = 0
  if (work !== source && work !== input) work.width = work.height = 0
  return { detections, text: firstText, entities: firstEntities }
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
