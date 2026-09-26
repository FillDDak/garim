/** Rough relative glyph width, used to locate a substring inside a measured text run. */
export function charWeight(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (ch === ' ') return 0.32
  if (c >= 0xac00 && c <= 0xd7a3) return 1 // Hangul syllables
  if ((c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) return 1
  if (/[0-9]/.test(ch)) return 0.56
  if (/[A-Z@#%&MW]/.test(ch)) return 0.68
  if (/[a-z]/.test(ch)) return 0.52
  if (/[.,:;'!|il]/.test(ch)) return 0.28
  if (/[-()\[\]/]/.test(ch)) return 0.36
  return 0.55
}

/** Fraction [from, to] of the run's width covered by characters [s, e). */
export function spanFraction(str: string, s: number, e: number): [number, number] {
  let total = 0
  let a = 0
  let b = 0
  for (let k = 0; k < str.length; k++) {
    const w = charWeight(str[k])
    if (k < s) a += w
    if (k < e) b += w
    total += w
  }
  if (!total) return [0, 1]
  return [a / total, b / total]
}
