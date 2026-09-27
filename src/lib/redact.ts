export type RedactStyle = 'black' | 'pixelate' | 'blur' | 'white'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
  /** Optional rotation (radians, clockwise) around the rectangle centre. */
  angle?: number
  /** Optional exact polygon (TL, TR, BR, BL); x/y/w/h are then its bounding box. */
  quad?: Array<[number, number]>
}

/** Axis-aligned bounds of a (possibly rotated) rectangle. */
export function boundsOf(r: Rect): Rect {
  if (!r.angle) return r
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const c = Math.abs(Math.cos(r.angle))
  const s = Math.abs(Math.sin(r.angle))
  const w = r.w * c + r.h * s
  const h = r.w * s + r.h * c
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

const clampRect = (r: Rect, W: number, H: number): Rect | null => {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const x2 = Math.min(W, Math.ceil(r.x + r.w))
  const y2 = Math.min(H, Math.ceil(r.y + r.h))
  if (x2 - x < 1 || y2 - y < 1) return null
  return { x, y, w: x2 - x, h: y2 - y }
}

/** Paint one redaction onto `ctx` (whose current pixels are the source image). */
export function paintRedaction(ctx: CanvasRenderingContext2D, rect: Rect, style: RedactStyle) {
  if (rect.quad) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath()
    rect.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.clip()
    paintRedaction(ctx, { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, style)
    ctx.restore()
    return
  }
  if (rect.angle) {
    // clip to the rotated rectangle, then redact its bounding box
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rect.angle)
    ctx.beginPath()
    ctx.rect(-rect.w / 2, -rect.h / 2, rect.w, rect.h)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clip()
    paintRedaction(ctx, boundsOf(rect), style)
    ctx.restore()
    return
  }
  const { width: W, height: H } = ctx.canvas
  const r = clampRect(rect, W, H)
  if (!r) return
  if (style === 'black' || style === 'white') {
    ctx.fillStyle = style === 'black' ? '#000' : '#fff'
    ctx.fillRect(r.x, r.y, r.w, r.h)
    return
  }
  // Pixelate: downsample the region hard, then scale it back without smoothing.
  // Blur is implemented as a heavy pixelate + soft upscale so it cannot be "un-blurred"
  // and it works in every browser (ctx.filter is not universally supported).
  const block = Math.max(8, Math.round(Math.min(r.h, 80) / (style === 'blur' ? 2.2 : 3.2)))
  const sw = Math.max(1, Math.round(r.w / block))
  const sh = Math.max(1, Math.round(r.h / block))
  const tmp = document.createElement('canvas')
  tmp.width = sw
  tmp.height = sh
  const t = tmp.getContext('2d')!
  t.imageSmoothingEnabled = true
  t.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, sw, sh)
  // add a little noise so the original cannot be reconstructed from block averages
  const img = t.getImageData(0, 0, sw, sh)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 36
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n))
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n))
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n))
  }
  t.putImageData(img, 0, 0)
  ctx.save()
  ctx.imageSmoothingEnabled = style === 'blur'
  if (style === 'blur') ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h)
  ctx.restore()
}

export async function loadImageToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    // cap giant photos to keep memory reasonable (still > 4K)
    const max = 5000
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    canvas.width = Math.round(img.naturalWidth * s)
    canvas.height = Math.round(img.naturalHeight * s)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('이미지 변환 실패'))), type, quality))
}
