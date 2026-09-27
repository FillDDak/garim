import { describe, expect, it } from 'vitest'
import { applyH, homography, type Point } from '../src/lib/perspective'

describe('homography', () => {
  it('maps the four corners exactly and interior points consistently', () => {
    const src: Point[] = [[0, 0], [100, 0], [100, 50], [0, 50]]
    const dst: Point[] = [[420, 180], [1250, 230], [1450, 1050], [180, 980]]
    const H = homography(src, dst)
    src.forEach((p, i) => {
      const [x, y] = applyH(H, ...p)
      expect(x).toBeCloseTo(dst[i][0], 6)
      expect(y).toBeCloseTo(dst[i][1], 6)
    })
    // round trip through the inverse homography
    const Hi = homography(dst, src)
    const [mx, my] = applyH(H, 37, 21)
    const [bx, by] = applyH(Hi, mx, my)
    expect(bx).toBeCloseTo(37, 6)
    expect(by).toBeCloseTo(21, 6)
  })
})
