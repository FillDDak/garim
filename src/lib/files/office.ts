import JSZip from 'jszip'
import { detect } from '../../core/engine'
import { applyMask } from '../../core/mask'
import type { DetectOptions, Entity, MappingEntry, MaskOptions, MaskResult } from '../../core/types'
import { decodeBytes } from './text'

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'hwpx'

interface PartSpec {
  /** Files inside the zip to process. */
  match: RegExp
  paragraph: string
  text: string
}

const SPECS: Record<OfficeKind, PartSpec[]> = {
  docx: [{ match: /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/, paragraph: 'w:p', text: 'w:t' }],
  pptx: [
    { match: /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/, paragraph: 'a:p', text: 'a:t' },
    { match: /^ppt\/comments\/.*\.xml$/, paragraph: 'p:cm', text: 'p:text' },
  ],
  xlsx: [
    { match: /^xl\/sharedStrings\.xml$/, paragraph: 'si', text: 't' },
    { match: /^xl\/worksheets\/sheet\d+\.xml$/, paragraph: 'is', text: 't' },
    { match: /^xl\/comments\d*\.xml$/, paragraph: 'comment', text: 't' },
  ],
  hwpx: [{ match: /^Contents\/section\d+\.xml$/, paragraph: 'hp:p', text: 'hp:t' }],
}

export function officeKind(name: string): OfficeKind | null {
  const m = name.toLowerCase().match(/\.(docx|pptx|xlsx|hwpx)$/)
  return (m?.[1] as OfficeKind) ?? null
}

interface TextRef {
  node: Text
  start: number
  end: number
}

interface Collected {
  doc: Document
  path: string
  refs: TextRef[]
}

/** Nearest ancestor element with the given tag name. */
function closest(el: Node | null, tag: string): Element | null {
  let cur: Node | null = el
  while (cur) {
    if (cur.nodeType === 1 && (cur as Element).tagName === tag) return cur as Element
    cur = cur.parentNode
  }
  return null
}

function collectParagraphs(doc: Document, spec: PartSpec, offset: number, sink: string[]): { refs: TextRef[]; length: number } {
  const refs: TextRef[] = []
  let pos = offset
  const paragraphs = Array.from(doc.getElementsByTagName(spec.paragraph))
  for (const p of paragraphs) {
    const textEls = Array.from(p.getElementsByTagName(spec.text)).filter((t) => closest(t.parentNode, spec.paragraph) === p)
    let para = ''
    for (const t of textEls) {
      // only direct text children (hp:t may contain <hp:tab/> etc.)
      for (const child of Array.from(t.childNodes)) {
        if (child.nodeType !== 3 && child.nodeType !== 4) continue
        const node = child as Text
        const s = pos + para.length
        para += node.data
        refs.push({ node, start: s, end: s + node.data.length })
      }
    }
    if (!para) continue
    sink.push(para)
    pos += para.length + 1 // "\n" separator
  }
  return { refs, length: pos - offset }
}

function rewrite(refs: TextRef[], result: MaskResult, entities: Entity[], disabled: ReadonlySet<string>) {
  const active = entities.filter((e) => !disabled.has(e.id))
  const repl = new Map<string, string>()
  for (const s of result.segments) if (s.kind === 'mask') repl.set(s.entityId, s.text)
  let ei = 0
  for (const ref of refs) {
    const src = ref.node.data
    let out = ''
    for (let i = ref.start; i < ref.end; i++) {
      while (ei < active.length && active[ei].end <= i) ei++
      const e = active[ei]
      if (e && e.start <= i && i < e.end) {
        // the replacement is emitted once, in the node where the entity starts
        if (i === e.start) out += repl.get(e.id) ?? ''
        continue
      }
      out += src[i - ref.start]
    }
    if (out !== src) {
      ref.node.data = out
      const parent = ref.node.parentNode as Element | null
      if (parent && /^\s|\s$/.test(out) && parent.tagName === 'w:t') parent.setAttribute('xml:space', 'preserve')
    }
  }
}

function scrubMetadata(path: string, xml: string): string | null {
  if (path === 'docProps/core.xml') {
    return xml
      .replace(/(<dc:creator>)[\s\S]*?(<\/dc:creator>)/g, '$1$2')
      .replace(/(<cp:lastModifiedBy>)[\s\S]*?(<\/cp:lastModifiedBy>)/g, '$1$2')
  }
  if (path === 'docProps/app.xml') {
    return xml.replace(/(<Company>)[\s\S]*?(<\/Company>)/g, '$1$2').replace(/(<Manager>)[\s\S]*?(<\/Manager>)/g, '$1$2')
  }
  if (/^Contents\/content\.hpf$/.test(path)) {
    return xml.replace(/(<opf:meta name="(?:creator|lastsaveby)"[^>]*>)[\s\S]*?(<\/opf:meta>)/g, '$1$2')
  }
  return null
}

export interface OfficeResult {
  blob: Blob
  text: string
  masked: MaskResult
  entities: Entity[]
  notes: string[]
}

const BLANK_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)

export async function processOffice(
  data: ArrayBuffer,
  kind: OfficeKind,
  detectOpts: DetectOptions,
  maskOpts: MaskOptions,
  prior: MappingEntry[],
): Promise<OfficeResult> {
  const zip = await JSZip.loadAsync(data)
  const parser = new DOMParser()
  const serializer = new XMLSerializer()
  const notes: string[] = []
  const collected: Collected[] = []
  const sink: string[] = []
  let offset = 0

  const paths = Object.keys(zip.files)
    .filter((p) => !zip.files[p].dir)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  for (const path of paths) {
    const spec = SPECS[kind].find((s) => s.match.test(path))
    if (!spec) continue
    const xml = await zip.file(path)!.async('string')
    const doc = parser.parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) continue
    const { refs, length } = collectParagraphs(doc, spec, offset, sink)
    offset += length
    collected.push({ doc, path, refs })
  }

  const fullText = sink.join('\n')
  const entities = detect(fullText, detectOpts)
  const masked = applyMask(fullText, entities, new Set(), maskOpts, prior)

  for (const c of collected) {
    rewrite(c.refs, masked, entities, new Set())
    let out = serializer.serializeToString(c.doc)
    if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + out
    zip.file(c.path, out)
  }

  // metadata + previews
  for (const path of paths) {
    const scrub = ['docProps/core.xml', 'docProps/app.xml', 'Contents/content.hpf'].includes(path)
    if (scrub) {
      const xml = await zip.file(path)!.async('string')
      const next = scrubMetadata(path, xml)
      if (next != null && next !== xml) {
        zip.file(path, next)
        if (!notes.includes('작성자·회사 등 문서 속성 정보를 지웠어요')) notes.push('작성자·회사 등 문서 속성 정보를 지웠어요')
      }
    }
    if (path === 'Preview/PrvText.txt') {
      const buf = await zip.file(path)!.async('arraybuffer')
      const t = decodeBytes(buf).text
      const r = applyMask(t, detect(t, detectOpts), new Set(), maskOpts, masked.mapping.length ? [...prior, ...masked.mapping] : prior)
      zip.file(path, r.text)
      notes.push('한글 미리보기 텍스트도 가렸어요')
    }
    if (/^Preview\/PrvImage\.(png|bmp|jpe?g|gif)$/i.test(path) || /^docProps\/thumbnail\.(png|jpe?g|emf|wmf)$/i.test(path)) {
      if (/\.png$/i.test(path)) {
        zip.file(path, BLANK_PNG)
        notes.push('첫 페이지 미리보기 이미지를 비웠어요')
      } else {
        zip.remove(path)
        notes.push('첫 페이지 미리보기 이미지를 삭제했어요')
      }
    }
  }

  if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx' || kind === 'hwpx') {
    notes.push('문서 안의 이미지 속 글자는 가려지지 않아요. 필요하면 ‘이미지’ 탭을 이용하세요')
  }

  const mime: Record<OfficeKind, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    hwpx: 'application/hwp+zip',
  }
  // hwpx (like ODF/EPUB) requires the "mimetype" entry to be stored uncompressed
  const mimetype = zip.file('mimetype')
  if (mimetype) zip.file('mimetype', await mimetype.async('string'), { compression: 'STORE' })
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: mime[kind],
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  return { blob, text: fullText, masked, entities, notes }
}
