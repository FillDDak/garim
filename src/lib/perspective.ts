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
export function findDocumentQuad(source: HTMLCanvasElement): Point[] | null {
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

  // largest bright connected component (4-neighbourhood flood fill)
  const label = new Int32Array(w * h).fill(-1)
  let bestLabel = -1
  let bestSize = 0
  const stack: number[] = []
  let cur = 0
  for (let i = 0; i < w * h; i++) {
    if (gray[i] <= t || label[i] !== -1) continue
    let size = 0
    stack.push(i)
    label[i] = cur
    while (stack.length) {
      const p = stack.pop()!
      size++
      const x = p % w
      const y = (p / w) | 0
      const visit = (q: number) => {
        if (label[q] === -1 && gray[q] > t) {
          label[q] = cur
          stack.push(q)
        }
      }
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (y > 0) visit(p - w)
      if (y < h - 1) visit(p + w)
    }
    if (size > bestSize) {
      bestSize = size
      bestLabel = cur
    }
    cur++
  }
  const areaFrac = bestSize / (w * h)
  if (areaFrac < 0.12 || areaFrac > 0.95) return null

  // boundary pixels of the component → hull → quad
  const boundary: Point[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (label[i] !== bestLabel) continue
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || label[i - 1] !== bestLabel || label[i + 1] !== bestLabel || label[i - w] !== bestLabel || label[i + w] !== bestLabel)
        boundary.push([x, y])
    }
  }
  const hl = hull(boundary)
  if (hl.length < 4) return null
  const quad = bestQuad(hl)
  const qa = polygonArea(quad)
  // the sheet must really be quadrilateral (not a blob) and not touch most of the frame edges
  if (qa < bestSize * 0.85 || qa > bestSize * 1.3) return null
  const touching = quad.filter(([x, y]) => x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2).length
  if (touching >= 3) return null
  // ignore if it is already an axis-aligned, undistorted rectangle (nothing to correct)
  const [tl, tr, br, bl] = quad
  const skewed =
    Math.abs(tl[1] - tr[1]) > h * 0.02 || Math.abs(bl[1] - br[1]) > h * 0.02 || Math.abs(tl[0] - bl[0]) > w * 0.02 || Math.abs(tr[0] - br[0]) > w * 0.02
  if (!skewed) return null
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
