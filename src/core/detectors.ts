import { escapeRe } from './util'
import type { Confidence, DetectOptions, EntitySource, EntityType } from './types'
import {
  bizNoChecksum,
  corpNoChecksum,
  digitsOf,
  isValidBirthDate,
  isValidIPv4,
  luhn,
  rrnChecksum,
} from './validators'
import { NAME_LABELS, NAME_TITLES, KOREAN_PARTICLES, isPlausibleName, NAME_STOPWORDS } from './names'

export interface Candidate {
  type: EntityType
  start: number
  end: number
  confidence: Confidence
  source: EntitySource
  note?: string
  label?: string
}

type Detector = (text: string, opts?: DetectOptions) => Candidate[]

const H = '가-힣'

/** Look at up to `n` chars before `index` (lowercased). */
const before = (text: string, index: number, n: number) => text.slice(Math.max(0, index - n), index).toLowerCase()
const after = (text: string, index: number, n: number) => text.slice(index, index + n).toLowerCase()

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = r.exec(text)) !== null) {
    if (m[0].length === 0) {
      r.lastIndex++
      continue
    }
    yield m
  }
}

/** Start/end of capture group `g` using the `d` (indices) flag. */
function groupRange(m: RegExpExecArray, g: number): [number, number] | null {
  const idx = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices
  const r = idx?.[g]
  return r ? [r[0], r[1]] : null
}

// ─── 주민등록번호 / 외국인등록번호 / 법인등록번호 ──────────────────────────
const RRN_RE = /(?<![\d])(\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(\s?[-–~_]\s?|\s)?([0-9])(\d{6}|\*{6}|[xX]{6}|●{6})(?![\d])/g

const detectRRN: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(RRN_RE, text)) {
    const front = m[1]
    const sep = m[2] ?? ''
    const g = Number(m[3])
    const tail = m[4]
    const start = m.index
    const end = start + m[0].length
    const masked = !/^\d+$/.test(tail)
    const ctx = before(text, start, 20)
    const digits = front + m[3] + (masked ? '' : tail)

    // 법인등록번호: not a valid birth date, or explicitly labelled ("주민(법인)등록번호" is still personal)
    const corpLabel = /법인/.test(ctx) && !/주민/.test(ctx)
    if (!masked && (corpLabel || !isValidBirthDate(front, g))) {
      if (/주민|외국인/.test(ctx)) {
        // labelled as a resident number but the date looks off (OCR misread): still mask it
        out.push({ type: 'rrn', start, end, confidence: 'medium', source: 'context', note: '주민등록번호 항목' })
        continue
      }
      if (corpLabel || (sep && corpNoChecksum(digits))) {
        out.push({ type: 'corpno', start, end, confidence: corpNoChecksum(digits) ? 'high' : 'medium', source: 'rule', note: corpNoChecksum(digits) ? '체크섬 검증됨' : undefined })
      }
      continue
    }
    if (!isValidBirthDate(front, g)) continue
    const isForeign = g >= 5 && g <= 8
    const type: EntityType = isForeign ? 'frn' : 'rrn'
    if (masked) {
      out.push({ type, start, end, confidence: 'medium', source: 'rule', note: '뒷자리가 일부 가려진 형식' })
      continue
    }
    const valid = rrnChecksum(digits)
    const labelled = /주민|외국인|등록번호|rrn|생년/.test(ctx)
    let confidence: Confidence = 'low'
    if (valid || labelled) confidence = 'high'
    else if (sep.includes('-') || sep.includes('–')) confidence = 'high'
    else if (sep) confidence = 'medium'
    else confidence = 'medium'
    out.push({
      type,
      start,
      end,
      confidence,
      source: 'rule',
      note: valid ? '체크섬 검증됨' : '형식 일치 (2020년 10월 이후 발급 번호는 체크섬이 없음)',
    })
  }
  return out
}

// ─── 전화번호 ─────────────────────────────────────────────────────────────
const MOBILE_RE = /(?<![\d+])(?:(\+82)[\s-]?(?:\(0\))?|)(0?1[016789])(?:[\s.\-)]{1,2})?(\d{3,4})(?:[\s.-])?(\d{4})(?![\d])/g
const LANDLINE_RE = /(?<![\d])(\((?:02|0[3-6][1-5]|070|050\d|080)\)\s?|(?:02|0[3-6][1-5]|070|050\d|080)(?:[\s.-]|\)\s?))(\d{3,4})([\s.-])(\d{4})(?![\d])/g
const LANDLINE_COMPACT_RE = /(?<![\d])(02\d{7,8}|0[3-6][1-5]\d{7,8}|070\d{8})(?![\d])/g

const detectPhone: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(MOBILE_RE, text)) {
    const international = !!m[1]
    const prefix = m[2]
    if (!international && !prefix.startsWith('0')) continue
    // 010 must be followed by 4 digits in the middle group
    if (/^0?10$/.test(prefix) && m[3].length !== 4) continue
    out.push({ type: 'phone', start: m.index, end: m.index + m[0].length, confidence: 'high', source: 'rule', note: '휴대전화' })
  }
  for (const m of matches(LANDLINE_RE, text)) {
    const start = m.index
    // avoid matching parts of dates like 2024-05-1234
    out.push({ type: 'phone', start, end: start + m[0].length, confidence: 'high', source: 'rule', note: '유선/인터넷 전화' })
  }
  for (const m of matches(LANDLINE_COMPACT_RE, text)) {
    const ctx = before(text, m.index, 15)
    if (/(전화|tel|연락|fax|팩스|번호|phone|☎|📞)/.test(ctx)) {
      out.push({ type: 'phone', start: m.index, end: m.index + m[0].length, confidence: 'medium', source: 'context', note: '유선전화 (문맥)' })
    }
  }
  return out
}

// ─── 이메일 ────────────────────────────────────────────────────────────────
const EMAIL_RE = /(?<![\w.+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,63})@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?![\w-])/g
const detectEmail: Detector = (text) =>
  [...matches(EMAIL_RE, text)].map((m) => ({ type: 'email' as const, start: m.index, end: m.index + m[0].length, confidence: 'high' as const, source: 'rule' as const }))

// ─── 카드번호 ──────────────────────────────────────────────────────────────
const CARD_RE = /(?<![\d-])(\d{4})([\s-]?)(\d{4})\2(\d{4})\2(\d{4}|\d{3})(?![\d-])/g
const AMEX_RE = /(?<![\d-])(3[47]\d{2})([\s-]?)(\d{6})\2(\d{5})(?![\d-])/g
const CARD_MASKED_RE = /(?<![\d-])(\d{4})([\s-])(\d{2}\*{2}|\*{4}|\d{4})\2(\*{4})\2(\d{4}|\*{4}|\d{3})(?![\d-])/g
const detectCard: Detector = (text) => {
  const out: Candidate[] = []
  for (const re of [CARD_RE, AMEX_RE]) {
    for (const m of matches(re, text)) {
      const d = digitsOf(m[0])
      const ctx = before(text, m.index, 20)
      const valid = luhn(d)
      const labelled = /(카드|card|신용|체크|결제)/.test(ctx)
      if (!valid && !labelled) continue
      out.push({ type: 'card', start: m.index, end: m.index + m[0].length, confidence: valid ? 'high' : 'medium', source: valid ? 'rule' : 'context', note: valid ? 'Luhn 검증됨' : '문맥상 카드번호' })
    }
  }
  for (const m of matches(CARD_MASKED_RE, text)) {
    out.push({ type: 'card', start: m.index, end: m.index + m[0].length, confidence: 'medium', source: 'rule', note: '일부 가려진 카드번호' })
  }
  return out
}

// ─── 계좌번호 ──────────────────────────────────────────────────────────────
const BANKS =
  '국민|KB|신한|우리|하나|농협|NH|기업|IBK|카카오뱅크|카카오|카뱅|토스뱅크|토스|케이뱅크|K뱅크|새마을|MG|신협|우체국|SC제일|제일|씨티|수협|부산|대구|경남|광주|전북|제주|산업|KDB|저축은행|은행|증권|미래에셋|삼성증권|키움'
const ACCOUNT_CTX_RE = new RegExp(`(${BANKS}|계좌|입금|송금|이체|예금주|account|acct|환불)`, 'i')
const ACCOUNT_RE = /(?<![\d-])(\d{2,6}(?:[-\s]\d{2,7}){1,3}|\d{10,14})(?![\d-])/g

const detectAccount: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(ACCOUNT_RE, text)) {
    const d = digitsOf(m[0])
    if (d.length < 10 || d.length > 16) continue
    const ctxBefore = before(text, m.index, 25)
    const ctxAfter = after(text, m.index + m[0].length, 15)
    if (!ACCOUNT_CTX_RE.test(ctxBefore) && !/^\s*\(?\s*(국민|신한|우리|하나|농협|기업|카카오|토스|케이|새마을|신협|우체국|은행|예금주)/.test(ctxAfter)) continue
    out.push({ type: 'account', start: m.index, end: m.index + m[0].length, confidence: 'high', source: 'context', note: '은행/계좌 문맥' })
  }
  return out
}

// ─── 사업자등록번호 ────────────────────────────────────────────────────────
const BIZ_RE = /(?<![\d-])(\d{3})-(\d{2})-(\d{5})(?![\d-])/g
const BIZ_COMPACT_RE = /(?<![\d-])(\d{10})(?![\d-])/g
const detectBiz: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(BIZ_RE, text)) {
    const valid = bizNoChecksum(digitsOf(m[0]))
    const labelled = /사업자|등록번호|biz/.test(before(text, m.index, 20))
    if (!valid && !labelled) continue
    out.push({ type: 'bizno', start: m.index, end: m.index + m[0].length, confidence: valid ? 'high' : 'medium', source: 'rule', note: valid ? '체크섬 검증됨' : '문맥상 사업자번호' })
  }
  for (const m of matches(BIZ_COMPACT_RE, text)) {
    if (!/사업자/.test(before(text, m.index, 20))) continue
    out.push({ type: 'bizno', start: m.index, end: m.index + m[0].length, confidence: 'medium', source: 'context' })
  }
  return out
}

// ─── 여권번호 ──────────────────────────────────────────────────────────────
const PASSPORT_RE = /(?<![A-Za-z0-9])([MSRODG]\d{8}|[MSRODG]\d{3}[A-Z]\d{4})(?![A-Za-z0-9])/g
const detectPassport: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(PASSPORT_RE, text)) {
    const labelled = /(여권|passport)/.test(before(text, m.index, 30))
    const newFormat = /^[A-Z]\d{3}[A-Z]\d{4}$/.test(m[0])
    if (!labelled && !newFormat) continue
    out.push({ type: 'passport', start: m.index, end: m.index + m[0].length, confidence: labelled ? 'high' : 'medium', source: labelled ? 'context' : 'rule' })
  }
  return out
}

// ─── 운전면허번호 ──────────────────────────────────────────────────────────
const DRIVER_RE = /(?<![\d-])((?:서울|부산|경기|강원|충북|충남|전북|전남|경북|경남|제주|대구|인천|광주|대전|울산|경기남부|경기북부)\s?|)(1[1-9]|2[0-8]|\d{2})-(\d{2})-(\d{6})-(\d{2})(?![\d-])/g
const detectDriver: Detector = (text) =>
  [...matches(DRIVER_RE, text)].map((m) => ({
    type: 'driver' as const,
    start: m.index,
    end: m.index + m[0].length,
    confidence: 'high' as const,
    source: 'rule' as const,
  }))

// ─── 차량번호 ──────────────────────────────────────────────────────────────
const CAR_LETTERS = '가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주아바사자배하허호'
const CAR_RE = new RegExp(
  `(?<![${H}\\d])((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\\s?)?(\\d{2,3})\\s?([${CAR_LETTERS}])\\s?(\\d{4})(?![\\d])`,
  'g',
)
const detectCar: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(CAR_RE, text)) {
    const tailCtx = after(text, m.index + m[0].length, 3)
    // "12가 3456원" style amounts are not plates
    if (/^\s*(원|명|개|건|번|회|년|km)/.test(tailCtx)) continue
    const ctx = before(text, m.index, 20)
    const labelled = /(차량|차번|번호판|자동차|주차|car)/.test(ctx)
    out.push({ type: 'car', start: m.index, end: m.index + m[0].length, confidence: labelled ? 'high' : 'medium', source: labelled ? 'context' : 'rule' })
  }
  return out
}

// ─── 주소 ──────────────────────────────────────────────────────────────────
const SIDO =
  '서울특별시|서울시|서울|부산광역시|부산시|부산|대구광역시|대구시|대구|인천광역시|인천시|인천|광주광역시|광주시|광주|대전광역시|대전시|대전|울산광역시|울산시|울산|세종특별자치시|세종시|세종|경기도|경기|강원특별자치도|강원도|강원|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주특별자치도|제주도|제주'
const ADDRESS_RE = new RegExp(
  [
    `(?<![${H}])`,
    `(?:(?:${SIDO})\\s+)?`, // 시/도
    `(?:[${H}]{1,5}(?:시|군|구)\\s+){1,3}`, // 시/군/구 (최대 3단계: 성남시 분당구)
    `(?:[${H}]{1,5}(?:읍|면)\\s+)?`,
    `(?:[${H}\\d]{1,12}(?:로|길|동|리|가)(?:\\s?\\d{1,4}(?:번?길|가))?)`, // 도로명/동
    `(?:\\s*\\d{1,5}(?:-\\d{1,5})?(?:번지)?)`, // 건물번호/지번
    `(?:,?\\s*(?:[${H}A-Za-z0-9]{1,15}(?:아파트|빌라|오피스텔|타워|빌딩|맨션|하이츠|캐슬|자이|힐스테이트|푸르지오|래미안|e편한세상|아이파크|더샵|센트럴|파크|스퀘어|프라자|센터|주택)?\\s*)?(?:[A-Za-z]?\\d{1,4}동\\s*)?\\d{1,5}호)?`,
    `(?:,?\\s*(?:지하\\s?)?\\d{1,3}층)?`,
    `(?:\\s*\\([${H}A-Za-z0-9,\\s·-]{1,30}\\))?`,
  ].join(''),
  'g',
)
const DETAIL_ONLY_RE = new RegExp(`(?:(?<![${H}A-Za-z0-9])[${H}A-Za-z0-9]{2,15}(?:아파트|빌라|오피스텔|맨션)\\s*)?(?<![0-9])(\\d{1,4}동\\s*\\d{1,5}호)`, 'g')
const detectAddress: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(ADDRESS_RE, text)) {
    let s = m[0]
    // trim trailing whitespace/commas
    const trimmed = s.replace(/[\s,]+$/, '')
    s = trimmed
    const hasSido = new RegExp(`^(${SIDO})`).test(s)
    const hasNumber = /\d/.test(s)
    if (!hasNumber) continue
    const confidence: Confidence = hasSido ? 'high' : 'medium'
    out.push({ type: 'address', start: m.index, end: m.index + s.length, confidence, source: 'rule' })
  }
  for (const m of matches(DETAIL_ONLY_RE, text)) {
    out.push({ type: 'address', start: m.index, end: m.index + m[0].length, confidence: 'medium', source: 'rule', note: '동·호수' })
  }
  return out
}

// ─── 항목명으로 찾기 (신분증·등록증·서식) ──────────────────────────────────
const sp = (label: string) => label.split('').join('\\s?')
const ADDRESS_LABELS = ['주소', '사용본거지', '소재지', '주소지', '거주지', '등록기준지', '본적', '현주소', '실거주지', '배송지', '받는주소']
const ADDRESS_LABEL_RE = new RegExp(`(?:${ADDRESS_LABELS.map(sp).join('|')})\\s*(?:\\([^)\\n]{0,10}\\))?\\s*[:：]?[ \\t]*([^\\n]{4,90})`, 'gd')
const ADDRESS_WORD_RE = new RegExp(`[${H}\\d]+(?:특별시|광역시|자치시|자치도|도|시|군|구|읍|면|동|리|로|길|가)(?![${H}])`)
// "주민등록번호 851301-…" when OCR garbled the date part
const LABELLED_RRN_RE = /(?:주\s?민|외\s?국\s?인)[^\n\d]{0,16}(\d{6}\s?[-–~_]\s?[0-9][\d*●xX]{6})(?![\d])/gd
const VIN_RE = /(?:차\s?대\s?번\s?호|VIN)[^A-Z0-9]{0,6}([A-HJ-NPR-Z0-9](?: ?[A-HJ-NPR-Z0-9]){16})(?![A-Z0-9])/gd
// Korean-built vehicles (WMI KM*, KN*, KL*, KP*) are recognisable without a label
const KR_VIN_RE = /(?<![A-Z0-9])(K[LMNP][A-HJ-NPR-Z0-9](?: ?[A-HJ-NPR-Z0-9]){14})(?![A-Z0-9])/g

const detectLabelled: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(ADDRESS_LABEL_RE, text)) {
    const r = groupRange(m, 1)
    if (!r) continue
    let value = m[1]
    // stop at the next label of a form ("사용본거지 … 성명(명칭) …")
    const cut = value.search(/\s{2,}(?:성\s?명|이\s?름|주민|생년|연락처|전화|차\s?명|차종|용도|형식|최초)/)
    if (cut > 0) value = value.slice(0, cut)
    value = value.replace(/[\s,.|]+$/, '')
    if (!/[가-힣]/.test(value) || !ADDRESS_WORD_RE.test(value)) continue
    out.push({ type: 'address', start: r[0], end: r[0] + value.length, confidence: 'high', source: 'context', note: '주소 항목' })
  }
  for (const m of matches(LABELLED_RRN_RE, text)) {
    const r = groupRange(m, 1)
    if (r) out.push({ type: 'rrn', start: r[0], end: r[1], confidence: 'medium', source: 'context', note: '주민등록번호 항목' })
  }
  for (const m of matches(VIN_RE, text)) {
    const r = groupRange(m, 1)
    if (r) out.push({ type: 'car', start: r[0], end: r[1], confidence: 'high', source: 'context', note: '차대번호' })
  }
  for (const m of matches(KR_VIN_RE, text)) {
    // real VINs mix letters and digits
    if (!/\d.*\d.*\d/.test(m[1]) || !/[A-Z].*[A-Z].*[A-Z]/.test(m[1])) continue
    out.push({ type: 'car', start: m.index, end: m.index + m[1].length, confidence: 'medium', source: 'rule', note: '차대번호 형식' })
  }
  return out
}

// ─── IP 주소 ───────────────────────────────────────────────────────────────
const IPV4_RE = /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?![\d.]|\.\d)/g
const IPV6_RE = /(?<![\w:])((?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})(?![\w:])/g
const detectIP: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(IPV4_RE, text)) {
    if (!isValidIPv4(m[1])) continue
    // version numbers such as "v1.2.3.4"
    if (/v$|version\s*$|버전\s*$/i.test(before(text, m.index, 10))) continue
    out.push({ type: 'ip', start: m.index, end: m.index + m[0].length, confidence: 'high', source: 'rule' })
  }
  for (const m of matches(IPV6_RE, text)) {
    if ((m[1].match(/:/g) ?? []).length < 3) continue
    out.push({ type: 'ip', start: m.index, end: m.index + m[0].length, confidence: 'medium', source: 'rule', note: 'IPv6' })
  }
  return out
}

// ─── 비밀키 / 토큰 / 비밀번호 ──────────────────────────────────────────────
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, '개인 키'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API 키'],
  [/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, 'OpenAI API 키'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, 'GitHub 토큰'],
  [/github_pat_[A-Za-z0-9_]{22,}/g, 'GitHub 토큰'],
  [/glpat-[A-Za-z0-9_-]{20,}/g, 'GitLab 토큰'],
  [/(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}(?![A-Z0-9])/g, 'AWS 액세스 키'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'Google API 키'],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, 'Slack 토큰'],
  [/(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, 'Stripe 키'],
  [/hf_[A-Za-z0-9]{30,}/g, 'Hugging Face 토큰'],
  [/npm_[A-Za-z0-9]{36}/g, 'npm 토큰'],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'JWT'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'Slack 웹훅'],
  [/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[\w/-]+/g, 'Discord 웹훅'],
]
const SECRET_KV_RE = /(?<![A-Za-z])(password|passwd|pwd|pw|passcode|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth[_-]?key|private[_-]?key|비밀번호|패스워드|암호|비번|인증번호|OTP)(["']?\s*[:=]\s*["']?|\s+)([^\s"'`,;<>]{4,128})/gi
const BEARER_RE = /(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g
const CONN_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:(\S{1,128})@[^\s@/]+/gi

const detectSecret: Detector = (text) => {
  const out: Candidate[] = []
  for (const [re, note] of SECRET_PATTERNS) {
    for (const m of matches(re, text)) {
      out.push({ type: 'secret', start: m.index, end: m.index + m[0].length, confidence: 'high', source: 'rule', note })
    }
  }
  for (const m of matches(new RegExp(SECRET_KV_RE.source, 'gid'), text)) {
    const r = groupRange(m, 3)
    if (!r) continue
    const value = m[3]
    const isKorean = /[가-힣]/.test(m[1])
    // "비밀번호 변경" etc. are sentences, not secrets
    if (/^[가-힣]+$/.test(value)) continue
    if (m[2].trim() === '' && !isKorean) continue // "token xyz" without separator in English prose
    if (/^(null|none|undefined|true|false|\*+|x+|•+|●+|required|string|your[_-].*|<.*>|\$\{.*\}|process\.env.*)$/i.test(value)) continue
    out.push({ type: 'secret', start: r[0], end: r[1], confidence: 'high', source: 'context', note: `${m[1]} 값` })
  }
  for (const m of matches(new RegExp(BEARER_RE.source, 'gd'), text)) {
    const r = groupRange(m, 2)
    if (r) out.push({ type: 'secret', start: r[0], end: r[1], confidence: 'high', source: 'context', note: '인증 헤더' })
  }
  for (const m of matches(new RegExp(CONN_RE.source, 'gid'), text)) {
    const r = groupRange(m, 1)
    if (r) out.push({ type: 'secret', start: r[0], end: r[1], confidence: 'high', source: 'context', note: '접속 URL 비밀번호' })
  }
  return out
}

// ─── URL (개인 식별 쿼리) ──────────────────────────────────────────────────
const URL_TOKEN_RE = /https?:\/\/[^\s<>"')]+?[?&](?:token|key|apikey|api_key|access_token|auth|sig|signature|session|sid|code|password|email|phone)=[^\s<>"')&]+[^\s<>"')]*/gi
const detectUrl: Detector = (text) =>
  [...matches(URL_TOKEN_RE, text)].map((m) => ({
    type: 'url' as const,
    start: m.index,
    end: m.index + m[0].length,
    confidence: 'high' as const,
    source: 'rule' as const,
    note: '인증/개인 정보가 담긴 URL',
  }))

// ─── 생년월일 ──────────────────────────────────────────────────────────────
const BIRTH_RE = /(생년월일|생일|출생일?|DOB|Date of Birth|birth(?:day|date)?)\s*[:：]?\s*((?:19|20)\d{2} ?[.\-/년] ?\d{1,2} ?[.\-/월] ?\d{1,2}(?: ?일)?|(?:19|20)\d{6}|\d{6}|\d{2}\s?[.\-/]\s?\d{1,2}\s?[.\-/]\s?\d{1,2})/gid
const detectBirth: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(BIRTH_RE, text)) {
    const r = groupRange(m, 2)
    if (r) out.push({ type: 'birth', start: r[0], end: r[1], confidence: 'high', source: 'context' })
  }
  return out
}

// ─── 이름 ──────────────────────────────────────────────────────────────────

const spaced = (l: string) => (/^[가-힣]{2,3}$/.test(l) ? l.split('').join('\\s?') : l)
const LOOSE_LABELS = NAME_LABELS.filter((l) => l.replace(/\\s\?/g, '').length >= 3 || ['이름', '성명', '성함'].includes(l))
const NAME_LABEL_COLON_RE = new RegExp(
  `(?<![${H}A-Za-z])(?:${NAME_LABELS.map(spaced).join('|')}|(?:customer|user|full|first|last|real|display|contact|account|holder)?[_ -]?name|customer|From|To|Cc|보낸\\s?사람|받는\\s?사람)["']?\\s*(?:\\([^)]{0,10}\\))?\\s*[:：=]\\s*["']?([${H}]{2,5}|[A-Z][a-z]+(?: [A-Z][a-z]+){1,2})(?![${H}A-Za-z])`,
  'gid',
)
const NAME_LABEL_SPACE_RE = new RegExp(`(?<![${H}])(?:${LOOSE_LABELS.map(spaced).join('|')})\\s*(?:\\([^)\\n]{0,10}\\))?\\s+([${H}]{2,4})(?![${H}])`, 'gid')
const PARTICLE_ALT = KOREAN_PARTICLES.map(escapeRe).join('|')
const LONG_TITLES = NAME_TITLES.filter((t) => t.length >= 2).map(escapeRe).join('|') + '|(?:드림|올림|배상)(?![가-힣])'
const SHORT_TITLES = NAME_TITLES.filter((t) => t.length === 1).map(escapeRe).join('|')
const NAME_TITLE_RE = new RegExp(
  `(?<![${H}])([${H}]{3,4}?)\\s?(?:(?:${LONG_TITLES})|(?:${SHORT_TITLES})(?:${PARTICLE_ALT}|이에요|이세요|입니다|이신|께|에게|한테)?(?![${H}]))`,
  'gd',
)
const NAME_PARTICLE_RE = new RegExp(`(?<![${H}])([${H}]{3})(?:${PARTICLE_ALT})(?![${H}])`, 'gd')

export const detectNamesBasic: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(NAME_LABEL_COLON_RE, text)) {
    const r = groupRange(m, 1)
    if (!r) continue
    let value = m[1]
    // English names must really be capitalised (the regex runs case-insensitively for the labels)
    if (/^[A-Za-z]/.test(value) && !/^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/.test(value)) continue
    // "홍길동님" → drop honorific
    const honor = value.match(/(님|씨)$/)
    if (honor && value.length > 3) value = value.slice(0, -honor[0].length)
    if (/^[가-힣]+$/.test(value) && NAME_STOPWORDS.has(value)) continue
    if (/^[가-힣]+$/.test(value) && value.length > 4) continue
    out.push({ type: 'name', start: r[0], end: r[0] + value.length, confidence: 'high', source: 'context', note: '이름 항목' })
  }
  for (const m of matches(NAME_LABEL_SPACE_RE, text)) {
    const r = groupRange(m, 1)
    if (!r || !isPlausibleName(m[1])) continue
    out.push({ type: 'name', start: r[0], end: r[1], confidence: 'high', source: 'context', note: '이름 항목' })
  }
  for (const m of matches(NAME_TITLE_RE, text)) {
    const r = groupRange(m, 1)
    if (!r || !isPlausibleName(m[1])) continue
    out.push({ type: 'name', start: r[0], end: r[1], confidence: 'medium', source: 'context', note: '호칭 앞 이름' })
  }
  return out
}

// "안녕하세요, 김민수입니다" / "저는 김민수이고" (self introduction)
const NAME_INTRO_RE = new RegExp(`(?:안녕하세요|안녕하십니까|반갑습니다|저는|제 이름은)[\\s,.!~]*(?:[${H}A-Za-z0-9]{1,12}\\s+(?:[${H}]{1,6}\\s+)?)?([${H}]{3})(?:입니다|이에요|예요|이고요?|이며|라고\\s?합니다)`, 'gd')
// "Mr. John Smith", "Dr. Kim"
const NAME_EN_TITLE_RE = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gd

const ROMAN_SURNAMES =
  'KIM|LEE|YI|RHEE|PARK|PAK|CHOI|CHOE|CHOY|JUNG|JEONG|CHUNG|KANG|CHO|JO|YOON|YUN|JANG|CHANG|LIM|IM|HAN|OH|SEO|SUH|SHIN|SIN|KWON|HWANG|AHN|AN|SONG|JEON|JUN|CHUN|HONG|YOO|YU|RYU|KO|KOH|GO|MOON|MUN|YANG|SON|SOHN|BAE|BAEK|PAIK|HEO|HUH|NAM|SIM|SHIM|NOH|ROH|HA|KWAK|SUNG|SEONG|CHA|JOO|JU|WOO|KOO|KU|MIN|NA|JIN|JI|UM|EOM|CHAE|WON|BANG|GONG|HYUN|HAM|BYUN|BYEON|YEOM|CHOO|DO|SO|SEOK|SUK|SEOL|MA|GIL|YEON|WI|PYO|MYUNG|KI|BAN|WANG|GEUM|OK|YOOK|IN|MAENG|JE|MO|TAK|KUK|EUN|PYEON|YONG'
// "CHOI HYEONGYU", "HONG GIL-DONG", OCR-damaged "CHO) HYEONGYU" (uppercase, as printed on cards/passports)
const ROMAN_NAME_RE = new RegExp(`(?<![A-Za-z])((?:${ROMAN_SURNAMES})[)|!.,]?[ ]{1,3}[A-Z]{2,}(?:[- ]?[A-Z]{2,})?)(?![A-Za-z])`, 'g')
const ROMAN_STOP = /\b(CARD|BANK|VALID|THRU|MONTH|YEAR|STUDENT|KOREA|REPUBLIC|SEOUL|CITY|CO|LTD|INC|CORP|UNIVERSITY|COLLEGE|MEMBER|CLASS|GOLD|PLATINUM|DEBIT|CREDIT|CHECK|MASTER|VISA|NAME|DATE|NO|ID|TYPE|SEX|ISSUE|EXPIRY|PASSPORT|NATIONALITY|AUTHORITY|OF)\b/

// Revised (and common older) romanisation of one Korean syllable: onset + vowel + coda
const RR_SYLLABLE = /(?:KK|TT|PP|SS|JJ|CH|G|K|N|D|T|R|L|M|B|P|S|J|H)?(?:YAE|YEO|WAE|YOU|AE|YA|EO|YE|WA|OE|YO|WO|WE|WI|YU|EU|UI|OO|OU|A|E|O|U|I)(?:NG|K|N|T|L|M|P)?/y

// card issuers and companies printed in romanised Korean (also when OCR glues a letter on: "AHANA")
const ROMAN_BRAND = /HANA|SHINHAN|KOOKMIN|WOORI|NONGHYUP|SAMSUNG|HYUNDAI|LOTTE|KAKAO|SUHYUP|DAEGU|BUSAN|GWANGJU|JEONBUK|GYEONGNAM|SEOUL|INCHEON|KOREA|HANKOOK|DONGA/

/** Number of syllables when `word` reads as a romanised Korean given name (2–3 syllables), else 0. */
function romanSyllables(word: string): number {
  // shortest parse by dynamic programming (a syllable regex alone is greedy and can dead-end)
  const n = word.length
  const best = new Array<number>(n + 1).fill(Infinity)
  best[0] = 0
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue
    for (let j = i + 1; j <= Math.min(n, i + 6); j++) {
      RR_SYLLABLE.lastIndex = 0
      const m = RR_SYLLABLE.exec(word.slice(i, j))
      if (m && m[0].length === j - i) best[j] = Math.min(best[j], best[i] + 1)
    }
  }
  return best[n] >= 2 && best[n] <= 3 ? best[n] : 0
}

// ID documents: a line holding only a name ("최현규" under "학생증") is the holder's name
export const ID_DOC_RE = /학생증|주민등록증|운전면허증|자동차등록증|신분증|사원증|공무원증|외국인등록증|등록증|면허증|여권|건강보험증|복지카드|STUDENT\s?ID|ID\s?CARD|EMPLOYEE|PASSPORT|DRIVER/i
const ID_NAME_LINE_RE = new RegExp(`(?:^|\\n)[^${H}\\n]{0,4}([${H}]{3,4})[^${H}\\n]{0,4}(?=\\n|$)`, 'gd')

export const detectNamesExtra: Detector = (text, opts) => {
  const out: Candidate[] = []
  for (const m of matches(ROMAN_NAME_RE, text)) {
    if (ROMAN_STOP.test(m[1].replace(/^[A-Z]+[)|!.,]?\s+/, ''))) continue
    out.push({ type: 'name', start: m.index, end: m.index + m[1].length, confidence: 'medium', source: 'context', note: '영문 이름' })
  }
  if (opts?.idDocument || ID_DOC_RE.test(text)) {
    // "HYEONGYU" alone on a line (OCR lost or garbled the surname in front of it, "HO) HYEONGYU"):
    // cover the given name together with the damaged surname token before it
    let lineStart = 0
    for (const line of text.split('\n')) {
      const given = [...line.matchAll(/(?<![A-Za-z])[A-Z]{5,12}(?![A-Za-z])/g)].filter((g) => !ROMAN_STOP.test(g[0]) && !ROMAN_BRAND.test(g[0]) && romanSyllables(g[0]))
      const g = given[given.length - 1]
      // the rest of the line must be short noise, not a sentence
      if (g && line.replace(g[0], '').replace(/\s/g, '').length <= 7) {
        const before = line.slice(0, g.index).match(/(\S{1,6})\s*$/)
        const start = lineStart + (before ? g.index! - before[0].length : g.index!)
        const end = lineStart + g.index! + g[0].length
        if (!out.some((o) => o.start < end && o.end > start))
          out.push({ type: 'name', start, end, confidence: 'medium', source: 'context', note: '영문 이름 (신분증)' })
      }
      lineStart += line.length + 1
    }
    for (const m of matches(ID_NAME_LINE_RE, text)) {
      const r = groupRange(m, 1)
      if (!r || !isPlausibleName(m[1])) continue
      out.push({ type: 'name', start: r[0], end: r[1], confidence: 'medium', source: 'context', note: '신분증 속 이름' })
    }
  }
  for (const m of matches(NAME_INTRO_RE, text)) {
    const r = groupRange(m, 1)
    if (!r || !isPlausibleName(m[1])) continue
    out.push({ type: 'name', start: r[0], end: r[1], confidence: 'medium', source: 'context', note: '자기소개 속 이름' })
  }
  for (const m of matches(NAME_EN_TITLE_RE, text)) {
    const r = groupRange(m, 1)
    if (r) out.push({ type: 'name', start: r[0], end: r[1], confidence: 'medium', source: 'context', note: '영문 호칭 뒤 이름' })
  }
  return out
}

export const detectNamesStrong: Detector = (text) => {
  const out: Candidate[] = []
  for (const m of matches(NAME_PARTICLE_RE, text)) {
    const r = groupRange(m, 1)
    if (!r || !isPlausibleName(m[1])) continue
    out.push({ type: 'name', start: r[0], end: r[1], confidence: 'low', source: 'context', note: '이름 추정 (강화 모드)' })
  }
  return out
}

export const DETECTORS: Array<[EntityType | EntityType[], Detector]> = [
  ['secret', detectSecret],
  ['url', detectUrl],
  [['rrn', 'frn', 'corpno'], detectRRN],
  ['card', detectCard],
  ['driver', detectDriver],
  ['bizno', detectBiz],
  ['account', detectAccount],
  ['phone', detectPhone],
  ['email', detectEmail],
  ['passport', detectPassport],
  ['car', detectCar],
  ['address', detectAddress],
  [['address', 'car', 'rrn'], detectLabelled],
  ['ip', detectIP],
  ['birth', detectBirth],
  ['name', detectNamesBasic],
  ['name', detectNamesExtra],
]

/** Priority when two candidates overlap (higher wins). */
export const TYPE_PRIORITY: Record<EntityType, number> = {
  custom: 100,
  secret: 90,
  url: 85,
  rrn: 80,
  frn: 80,
  corpno: 75,
  card: 72,
  driver: 70,
  bizno: 66,
  account: 64,
  phone: 65,
  email: 60,
  passport: 55,
  birth: 50,
  car: 45,
  ip: 44,
  address: 40,
  name: 30,
}
