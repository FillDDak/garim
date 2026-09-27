import { describe, expect, it } from 'vitest'
import { normalizeOcrText, numberRuns } from '../src/lib/ocr'

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
