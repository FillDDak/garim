import { describe, expect, it } from 'vitest'
import { normalizeOcrText, numberRuns, covers, unionQuad } from '../src/lib/ocr'

describe('OCR text helpers', () => {
  it('fixes letter/digit confusions only inside number-like tokens', () => {
    expect(normalizeOcrText('01O-l234-5678')).toBe('010-1234-5678')
    expect(normalizeOcrText('HANA CARD SOLO')).toBe('HANA CARD SOLO')
    expect(normalizeOcrText('2O24541O12')).toBe('2024541012')
    expect(normalizeOcrText('01O-l234-5678').length).toBe('01O-l234-5678'.length)
  })
  it('flags long digit runs (student/card numbers) but not dates or short numbers', () => {
    const vals = (t: string) => numberRuns(t).map((e) => e.value)
    expect(vals('학번 2024541012')).toEqual(['2024541012'])
    expect(vals('9440 8100 4190 5176')).toEqual(['9440 8100 4190 5176'])
    expect(vals('i “0 #00 4190 5176 e')).toEqual(['0 #00 4190 5176'])
    expect(vals('2024-06-01 03/29 12:30')).toEqual([])
    expect(vals('총 1234개')).toEqual([])
  })
})

describe('covers (merging boxes found on differently transformed copies)', () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })
  it('a full card-number box covers the partial one read elsewhere', () => {
    expect(covers(rect(100, 100, 400, 40), rect(300, 102, 200, 36))).toBe(true)
    expect(covers(rect(300, 102, 200, 36), rect(100, 100, 400, 40))).toBe(false)
  })
  it('works for rotated polygons', () => {
    const quad: Array<[number, number]> = [
      [100, 100],
      [500, 60],
      [504, 100],
      [104, 140],
    ]
    const outer = { x: 100, y: 60, w: 404, h: 80, quad }
    expect(covers(outer, rect(250, 90, 100, 20))).toBe(true)
    expect(covers(outer, rect(250, 150, 100, 20))).toBe(false)
  })
})

describe('unionQuad', () => {
  it('joins two parallel rotated boxes into one covering both', () => {
    const q = (x: number): Array<[number, number]> => [
      [x, 100],
      [x + 100, 90],
      [x + 102, 110],
      [x + 2, 120],
    ]
    const a = { x: 100, y: 90, w: 102, h: 30, quad: q(100) }
    const b = { x: 40, y: 96, w: 102, h: 30, quad: q(40).map(([x, y]) => [x, y + 6] as [number, number]) }
    const u = unionQuad(a, b)!
    expect(u).not.toBeNull()
    expect(covers(u, a)).toBe(true)
    expect(covers(u, b)).toBe(true)
  })
  it('refuses boxes at different angles', () => {
    const a = { x: 0, y: 0, w: 100, h: 20 }
    const b = { x: 0, y: 0, w: 100, h: 100, quad: [[0, 0], [70, 70], [60, 80], [-10, 10]] as Array<[number, number]> }
    expect(unionQuad(a, b)).toBeNull()
  })
})

describe('unionQuad across lines', () => {
  it('never joins boxes on different text lines', () => {
    expect(unionQuad({ x: 0, y: 0, w: 200, h: 20 }, { x: 50, y: 12, w: 100, h: 20 })).toBeNull()
    expect(unionQuad({ x: 0, y: 0, w: 200, h: 20 }, { x: 150, y: 2, w: 100, h: 20 })).not.toBeNull()
  })
})
