/**
 * Estimates the text skew of a photo (in degrees, clockwise positive) with a projection profile:
 * when the image is rotated so text lines are horizontal, the row histogram of "ink" pixels is
 * the most peaky. Works on a downscaled copy and uses local contrast so uneven lighting and
 * dark table backgrounds don't dominate.
 */
export function estimateSkew(source: HTMLCanvasElement, maxAngle = 30): number {
  const target = 800
  const s = Math.min(1, target / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * s))
  const h = Math.max(1, Math.round(source.height * s))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  // grayscale + integral image for a fast local mean
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x]
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row
    }
  }
  const r = Math.max(6, Math.round(Math.min(w, h) / 40))
  const xs: number[] = []
  const ys: number[] = []
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]
      const mean = sum / ((x1 - x0) * (y1 - y0))
      // "ink": clearly darker than its neighbourhood
      if (gray[y * w + x] < mean - 25) {
        xs.push(x - w / 2)
        ys.push(y - h / 2)
      }
    }
  }
  if (xs.length < 200) return 0

  const diag = Math.ceil(Math.hypot(w, h))
  const bins = new Float64Array(diag + 2)
  const score = (deg: number) => {
    const t = (deg * Math.PI) / 180
    const sin = Math.sin(t)
    const cos = Math.cos(t)
    bins.fill(0)
    for (let i = 0; i < xs.length; i++) {
      const yr = -xs[i] * sin + ys[i] * cos + diag / 2
      bins[yr | 0]++
    }
    let sq = 0
    for (let i = 0; i < bins.length; i++) sq += bins[i] * bins[i]
    return sq
  }

  let best = 0
  let bestScore = score(0)
  for (let a = -maxAngle; a <= maxAngle; a += 1) {
    const v = score(a)
    if (v > bestScore) {
      bestScore = v
      best = a
    }
  }
  const coarse = best
  for (let a = coarse - 1; a <= coarse + 1; a += 0.2) {
    const v = score(a)
    if (v > bestScore) {
      bestScore = v
      best = a
    }
  }
  return best
}

/** Rotates `source` by -angle degrees (so skewed text becomes horizontal) onto an expanded canvas. */
export function rotateCanvas(source: HTMLCanvasElement, angleDeg: number): { canvas: HTMLCanvasElement; toSource: (x: number, y: number) => [number, number] } {
  const t = (-angleDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const W = source.width
  const H = source.height
  const nw = Math.ceil(Math.abs(W * cos) + Math.abs(H * sin))
  const nh = Math.ceil(Math.abs(W * sin) + Math.abs(H * cos))
  const canvas = document.createElement('canvas')
  canvas.width = nw
  canvas.height = nh
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, nw, nh)
  ctx.translate(nw / 2, nh / 2)
  ctx.rotate(t)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, -W / 2, -H / 2)
  // inverse mapping: rotated-canvas point → source point
  const toSource = (x: number, y: number): [number, number] => {
    const dx = x - nw / 2
    const dy = y - nh / 2
    return [dx * cos + dy * sin + W / 2, -dx * sin + dy * cos + H / 2]
  }
  return { canvas, toSource }
}

/**
 * Photo clean-up for OCR: grayscale, percentile contrast stretch and an unsharp mask.
 * Returns a new canvas upscaled so glyphs are large enough for recognition.
 */
export function enhanceForOcr(source: HTMLCanvasElement, minWidth = 2400): HTMLCanvasElement {
  const s = Math.max(1, Math.min(3, minWidth / source.width))
  const w = Math.round(source.width * s)
  const h = Math.round(source.height * s)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const gray = new Float32Array(w * h)
  const hist = new Uint32Array(256)
  for (let i = 0; i < w * h; i++) {
    const g = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114
    gray[i] = g
    hist[g | 0]++
  }
  // 2nd–98th percentile stretch
  const total = w * h
  let lo = 0
  let hi = 255
  for (let acc = 0, i = 0; i < 256; i++) if ((acc += hist[i]) >= total * 0.02) { lo = i; break }
  for (let acc = 0, i = 255; i >= 0; i--) if ((acc += hist[i]) >= total * 0.02) { hi = i; break }
  const span = Math.max(1, hi - lo)
  // unsharp mask with a 3x3 box blur
  const r = Math.max(1, Math.round(s))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let dy = -r; dy <= r; dy += r) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx += r) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += gray[yy * w + xx]
          n++
        }
      }
      const g = gray[y * w + x]
      const sharp = g + 1.2 * (g - sum / n)
      const v = Math.max(0, Math.min(255, ((sharp - lo) / span) * 255))
      const i = (y * w + x) * 4
      d[i] = d[i + 1] = d[i + 2] = v
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}
