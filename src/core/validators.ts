export const digitsOf = (s: string): string => s.replace(/\D/g, '')

/** Returns true when YYMMDD (with century inferred from the gender digit) is a real date. */
export function isValidBirthDate(yymmdd: string, genderDigit: number): boolean {
  if (!/^\d{6}$/.test(yymmdd)) return false
  const yy = Number(yymmdd.slice(0, 2))
  const mm = Number(yymmdd.slice(2, 4))
  const dd = Number(yymmdd.slice(4, 6))
  let century: number
  if (genderDigit === 9 || genderDigit === 0) century = 1800
  else if (genderDigit <= 2 || genderDigit === 5 || genderDigit === 6) century = 1900
  else century = 2000
  const year = century + yy
  if (mm < 1 || mm > 12 || dd < 1) return false
  const days = new Date(Date.UTC(year, mm, 0)).getUTCDate()
  return dd <= days
}

const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]

/**
 * 주민등록번호 / 외국인등록번호 checksum.
 * Numbers issued after Oct 2020 no longer carry a checksum, so a failed check does
 * not mean the number is fake — callers should treat it as "format only".
 */
export function rrnChecksum(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * RRN_WEIGHTS[i]
  const g = Number(digits[6])
  const check = g >= 5 && g <= 8 ? (13 - (sum % 11)) % 10 : (11 - (sum % 11)) % 10
  return check === Number(digits[12])
}

export function luhn(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** 사업자등록번호 checksum. */
export function bizNoChecksum(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5]
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * w[i]
  sum += Math.floor((Number(digits[8]) * 5) / 10)
  return (10 - (sum % 10)) % 10 === Number(digits[9])
}

/** 법인등록번호 checksum. */
export function corpNoChecksum(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 2)
  return (10 - (sum % 10)) % 10 === Number(digits[12])
}

export function isValidIPv4(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')))
}
