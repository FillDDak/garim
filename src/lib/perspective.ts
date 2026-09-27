/**
 * Perspective correction for photographed documents: find the sheet of paper, then warp it to a
 * flat, front-facing rectangle so OCR sees undistorted glyphs.
 */

export type Point = [number, number]

/** Otsu threshold of a grayscale histogram. */
function otsu(hist: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

function polygonArea(p: Point[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length
    a += p[i][0] * p[j][1] - p[j][0] * p[i][1]
  }
  return Math.abs(a) / 2
}

/** Convex hull (monotone chain). */
function hull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lower: Point[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Largest-area quadrilateral whose corners lie on the hull (greedy refinement from extremes). */
function bestQuad(h: Point[]): Point[] {
  const n = h.length
  if (n < 4) return h
  // start from the extreme corners, then locally improve each corner
  const pick = (f: (p: Point) => number) => h.reduce((bi, p, i) => (f(p) > f(h[bi]) ? i : bi), 0)
  let idx = [pick((p) => -p[0] - p[1]), pick((p) => p[0] - p[1]), pick((p) => p[0] + p[1]), pick((p) => -p[0] + p[1])]
  let area = polygonArea(idx.map((i) => h[i]))
  for (let iter = 0; iter < 6; iter++) {
    let improved = false
    for (let k = 0; k < 4; k++) {
      for (let c = 0; c < n; c++) {
        const trial = [...idx]
        trial[k] = c
        const a = polygonArea(trial.map((i) => h[i]))
        if (a > area + 1e-6) {
          area = a
          idx = trial
          improved = true
        }
      }
    }
    if (!improved) break
  }
  // order: top-left, top-right, bottom-right, bottom-left
  const q = idx.map((i) => h[i])
  const cx = q.reduce((a, p) => a + p[0], 0) / 4
  const cy = q.reduce((a, p) => a + p[1], 0) / 4
  q.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  // atan2 order starts at the left (-π): rotate so the corner with min x+y is first
  let start = 0
  for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[start][0] + q[start][1]) start = i
  return [...q.slice(start), ...q.slice(0, start)]
}

/**
 * Finds the four corners of a bright document on a darker background.
 * Returns null when the photo is already a flat scan / screenshot or no clear sheet is visible.
 */
export function findDocumentQuad(source: HTMLCanvasElement, debug?: { mask?: { w: number; h: number; data: Uint8Array }; reasons?: string[] }): Point[] | null {
  const target = 500
  const s = Math.min(1, target / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * s))
  const h = Math.max(1, Math.round(source.height * s))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const gray = new Uint8Array(w * h)
  const hist = new Uint32Array(256)
  for (let i = 0; i < w * h; i++) {
    const g = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0
    gray[i] = g
    hist[g]++
  }
  const t = otsu(hist, w * h)
  // paper = bright region; also require separation from the background
  let darkSum = 0
  let darkN = 0
  let lightSum = 0
  let lightN = 0
  for (let i = 0; i < w * h; i++) {
    if (gray[i] > t) {
      lightSum += gray[i]
      lightN++
    } else {
      darkSum += gray[i]
      darkN++
    }
  }
  if (!darkN || !lightN || lightSum / lightN - darkSum / darkN < 40) return null

  // Bright mask, closed morphologically so thin dark lines printed across the card (arcs, text)
  // don't split the sheet into several pieces.
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] > t ? 1 : 0
  // opening removes speckles (textured leather, wood grain); closing bridges printed lines
  const ro = Math.max(1, Math.round(Math.min(w, h) * 0.006))
  const rc = Math.max(3, Math.round(Math.min(w, h) * 0.03))
  const opened = dilate(erode(mask, w, h, ro), w, h, ro)
  const joined = erode(dilate(opened, w, h, rc), w, h, rc)
  // A strong opening cuts bridges between the sheet and other bright areas (desk, wall). Start
  // gentle and get stronger until a sheet-shaped region separates out.
  let best: { quad: Point[]; size: number; score: number } | null = null
  let rb = 0
  for (const frac of [0.05, 0.08, 0.11, 0.14]) {
    const r = Math.max(4, Math.round(Math.min(w, h) * frac))
    const closed = dilate(erode(joined, w, h, r), w, h, r)
    if (debug && !debug.mask) debug.mask = { w, h, data: closed }
    const found = findSheet(closed, w, h, debug)
    if (found && (!best || found.score > best.score * 1.05)) {
      best = found
      rb = r
    }
  }
  if (!best) return null
  // the strong opening rounds the corners inwards: push each corner back out along its diagonal
  const cx = best.quad.reduce((a, p) => a + p[0], 0) / 4
  const cy = best.quad.reduce((a, p) => a + p[1], 0) / 4
  const push = rb * 0.45
  const quad = best.quad.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1
    return [x + ((x - cx) / d) * push, y + ((y - cy) / d) * push] as Point
  })
  return quad.map(([x, y]) => [x / s, y / s] as Point)
}

/** Homography H (3x3, row-major) with H·src = dst for four point pairs. */
export function homography(src: Point[], dst: Point[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination on the 8x9 augmented matrix
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    const d = A[col][col] || 1e-12
    for (let k = col; k < 9; k++) A[col][k] /= d
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = A[r][col]
      if (!f) continue
      for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k]
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1]
}

export const applyH = (H: number[], x: number, y: number): Point => {
  const d = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Warps the quad (TL, TR, BR, BL) of `source` to a flat rectangle. */
export function warpQuad(source: HTMLCanvasElement, quad: Point[], maxSide = 2400): { canvas: HTMLCanvasElement; toSource: (x: number, y: number) => Point } {
  const [tl, tr, br, bl] = quad
  let W = Math.max(dist(tl, tr), dist(bl, br))
  let H = Math.max(dist(tl, bl), dist(tr, br))
  const k = Math.min(1.6, maxSide / Math.max(W, H))
  W = Math.round(W * k)
  H = Math.round(H * k)
  const dst: Point[] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ]
  const toSrc = homography(dst, quad)

  const sctx = source.getContext('2d', { willReadFrequently: true })!
  const sw = source.width
  const sh = source.height
  const sdata = sctx.getImageData(0, 0, sw, sh).data
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const out = ctx.createImageData(W, H)
  const o = out.data
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const [x, y] = applyH(toSrc, u + 0.5, v + 0.5)
      const x0 = Math.floor(x - 0.5)
      const y0 = Math.floor(y - 0.5)
      const fx = x - 0.5 - x0
      const fy = y - 0.5 - y0
      const i = (v * W + u) * 4
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        o[i] = o[i + 1] = o[i + 2] = 255
        o[i + 3] = 255
        continue
      }
      const a = (y0 * sw + x0) * 4
      const b = a + 4
      const c = a + sw * 4
      const d = c + 4
      for (let ch = 0; ch < 3; ch++) {
        o[i + ch] = (sdata[a + ch] * (1 - fx) + sdata[b + ch] * fx) * (1 - fy) + (sdata[c + ch] * (1 - fx) + sdata[d + ch] * fx) * fy
      }
      o[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return { canvas, toSource: (x, y) => applyH(toSrc, x, y) }
}

/** Binary dilation with a square window (separable running max). */
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(m, w, h, r, 1)
}

/** Binary erosion with a square window (separable running min). */
function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(m, w, h, r, 0)
}

function morph(m: Uint8Array, w: number, h: number, r: number, target: 0 | 1): Uint8Array {
  // dilation: pixel becomes 1 if any neighbour is 1; erosion: becomes 0 if any neighbour is 0
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let count = 0
    for (let x = -r; x < w; x++) {
      const add = x + r
      if (add < w && m[y * w + add] === target) count++
      const rem = x - r - 1
      if (rem >= 0 && m[y * w + rem] === target) count--
      if (x >= 0) tmp[y * w + x] = count > 0 ? target : 1 - target
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0
    for (let y = -r; y < h; y++) {
      const add = y + r
      if (add < h && tmp[add * w + x] === target) count++
      const rem = y - r - 1
      if (rem >= 0 && tmp[rem * w + x] === target) count--
      if (y >= 0) out[y * w + x] = count > 0 ? target : 1 - target
    }
  }
  return out
}

/** Best quadrilateral bright component of a binary mask (not touching 2+ image borders). */
function findSheet(closed: Uint8Array, w: number, h: number, debug?: { reasons?: string[] }): { quad: Point[]; size: number; score: number } | null {
  // Candidate sheets: bright components that are quadrilateral and not the (edge-touching) table
  const label = new Int32Array(w * h).fill(-1)
  const stack: number[] = []
  let cur = 0
  let best: { quad: Point[]; size: number; score: number } | null = null
  for (let i = 0; i < w * h; i++) {
    if (!closed[i] || label[i] !== -1) continue
    let size = 0
    let touchTop = 0
    let touchBottom = 0
    let touchLeft = 0
    let touchRight = 0
    const boundary: Point[] = []
    stack.push(i)
    label[i] = cur
    while (stack.length) {
      const p = stack.pop()!
      size++
      const x = p % w
      const y = (p / w) | 0
      if (y === 0) touchTop++
      if (y === h - 1) touchBottom++
      if (x === 0) touchLeft++
      if (x === w - 1) touchRight++
      let edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
      const visit = (q: number) => {
        if (!closed[q]) {
          edge = true
          return
        }
        if (label[q] === -1) {
          label[q] = cur
          stack.push(q)
        }
      }
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (y > 0) visit(p - w)
      if (y < h - 1) visit(p + w)
      if (edge) boundary.push([x, y])
    }
    cur++
    const areaFrac = size / (w * h)
    if (areaFrac < 0.06 || areaFrac > 0.92) continue
    const why = (r: string) => debug?.reasons?.push(`${size} ${r}`)
    const bordersTouched = [touchTop > w * 0.05, touchBottom > w * 0.05, touchLeft > h * 0.05, touchRight > h * 0.05].filter(Boolean).length
    if (bordersTouched >= 2) {
      why(`touches ${bordersTouched} borders`)
      continue
    }
    const hl = hull(boundary)
    if (hl.length < 4) continue
    const quad = bestQuad(hl)
    const qa = polygonArea(quad)
    // must really be a quadrilateral sheet, not a blob
    if (qa < size * 0.85 || qa > size * 1.25) {
      why(`not quad-like ${(qa / size).toFixed(2)}`)
      continue
    }
    // a sheet lying fully inside the photo is far more likely than a bright area cut by the frame
    const score = size * (bordersTouched ? 0.45 : 1)
    if (!best || score > best.score) best = { quad, size, score }
  }
  return best
}
