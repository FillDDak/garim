import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { detect } from '../../core/engine'
import { applyMask } from '../../core/mask'
import type { DetectOptions, Entity, MappingEntry, MaskOptions, MaskResult } from '../../core/types'
import { spanFraction } from '../textMetrics'

const BASE = import.meta.env.BASE_URL
const abs = (p: string) => new URL(`${BASE}${p}`, window.location.href).href

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })()
  }
  return pdfjsPromise
}

interface Item {
  str: string
  x: number
  y: number
  width: number
  size: number
  family: string
  start: number
  end: number
}

interface PageText {
  text: string
  items: Item[]
  /** offset of this page in the combined document text */
  offset: number
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const lib = await pdfjs()
  return lib.getDocument({
    data: new Uint8Array(data),
    cMapUrl: abs('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: abs('pdfjs/standard_fonts/'),
    wasmUrl: abs('pdfjs/wasm/'),
  }).promise
}

async function pageText(page: PDFPageProxy, offset: number): Promise<PageText> {
  const content = await page.getTextContent()
  const items: Item[] = []
  let text = ''
  let prev: Item | null = null
  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const tr = raw.transform as number[]
    const size = Math.hypot(tr[2], tr[3]) || raw.height || 10
    const x = tr[4]
    const y = tr[5]
    if (prev) {
      const sameLine = Math.abs(prev.y - y) < size * 0.5
      const lastChar = text[text.length - 1]
      if (!sameLine) {
        if (lastChar !== '\n') text += '\n'
      } else {
        const gap = x - (prev.x + prev.width)
        if (gap > size * 0.2 && lastChar !== ' ' && lastChar !== '\n' && !raw.str.startsWith(' ')) text += ' '
      }
    }
    const family = content.styles[raw.fontName]?.fontFamily ?? 'sans-serif'
    const item: Item = { str: raw.str, x, y, width: raw.width, size, family, start: offset + text.length, end: 0 }
    text += raw.str
    item.end = offset + text.length
    items.push(item)
    if (raw.hasEOL && !text.endsWith('\n')) text += '\n'
    prev = item
  }
  return { text, items, offset }
}

export interface PdfResult {
  pageCount: number
  text: string
  entities: Entity[]
  masked: MaskResult
  emptyPages: number
  doc: PDFDocumentProxy
  pages: PageText[]
}

export async function processPdf(
  data: ArrayBuffer,
  detectOpts: DetectOptions,
  maskOpts: MaskOptions,
  prior: MappingEntry[],
  onProgress?: (p: number) => void,
): Promise<PdfResult> {
  const doc = await openPdf(data)
  const pages: PageText[] = []
  let full = ''
  let emptyPages = 0
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const pt = await pageText(page, full.length)
    if (!pt.text.trim()) emptyPages++
    pages.push(pt)
    full += pt.text + '\n\n'
    onProgress?.(i / doc.numPages)
  }
  const entities = detect(full, detectOpts)
  const masked = applyMask(full, entities, new Set(), maskOpts, prior)
  return { pageCount: doc.numPages, text: full, entities, masked, emptyPages, doc, pages }
}

let measureCtx: CanvasRenderingContext2D | null = null

/** Width fraction of `str` up to character index `i`, measured with the run's font family. */
function fracAt(str: string, i: number, family: string): number {
  if (i <= 0) return 0
  if (i >= str.length) return 1
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (measureCtx) {
    measureCtx.font = `100px ${family}, sans-serif`
    const total = measureCtx.measureText(str).width
    if (total > 0) return measureCtx.measureText(str.slice(0, i)).width / total
  }
  return spanFraction(str, 0, i)[1]
}

export type BoxStyle = 'black' | 'white'

/**
 * Renders every page to an image, paints opaque boxes over detected entities and
 * assembles a new image-only PDF. The output contains no text layer, so the hidden
 * values cannot be recovered by copy/paste or by removing an annotation.
 */
export async function redactPdf(
  result: PdfResult,
  disabledIds: ReadonlySet<string>,
  style: BoxStyle,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  const active = result.entities.filter((e) => !disabledIds.has(e.id))
  const images: Array<{ jpeg: Uint8Array; w: number; h: number; pw: number; ph: number }> = []
  const scale = 2
  for (let i = 0; i < result.pageCount; i++) {
    const page = await result.doc.getPage(i + 1)
    const vp1 = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
    ctx.fillStyle = style === 'black' ? '#000' : '#fff'
    const pt = result.pages[i]
    for (const e of active) {
      for (const it of pt.items) {
        if (it.end <= e.start || it.start >= e.end || it.end === it.start) continue
        const s = Math.max(e.start, it.start) - it.start
        const en = Math.min(e.end, it.end) - it.start
        const x1 = it.x + it.width * fracAt(it.str, s, it.family)
        const x2 = it.x + it.width * fracAt(it.str, en, it.family)
        const pad = it.size * 0.18
        const [ax, ay] = vp.convertToViewportPoint(x1 - pad, it.y - it.size * 0.3) as [number, number]
        const [bx, by] = vp.convertToViewportPoint(x2 + pad, it.y + it.size * 1.0) as [number, number]
        const rect = [ax, ay, bx, by]
        const rx = Math.min(rect[0], rect[2])
        const ry = Math.min(rect[1], rect[3])
        ctx.fillRect(rx, ry, Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1]))
      }
    }
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', 0.88))
    images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height, pw: vp1.width, ph: vp1.height })
    canvas.width = canvas.height = 0
    onProgress?.((i + 1) / result.pageCount)
  }
  return buildImagePdf(images)
}

/** Minimal PDF writer: one full-page JPEG per page. */
export function buildImagePdf(pages: Array<{ jpeg: Uint8Array; w: number; h: number; pw: number; ph: number }>): Blob {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (c: Uint8Array | string) => {
    const b = typeof c === 'string' ? enc.encode(c) : c
    chunks.push(b)
    length += b.length
  }
  const obj = (n: number, body: string | Array<string | Uint8Array>) => {
    offsets[n] = length
    push(`${n} 0 obj\n`)
    if (typeof body === 'string') push(body)
    else body.forEach(push)
    push('\nendobj\n')
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const n = pages.length
  const pageIds = pages.map((_, i) => 3 + i * 3)
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>`)
  pages.forEach((p, i) => {
    const pid = 3 + i * 3
    const cid = pid + 1
    const iid = pid + 2
    const pw = p.pw.toFixed(2)
    const ph = p.ph.toFixed(2)
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`)
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`
    obj(cid, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    obj(iid, [
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    ])
  })
  const total = 3 + n * 3
  const xref = length
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  push(x)
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}
