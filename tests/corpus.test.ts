import { describe, expect, it } from 'vitest'
import { detect, defaultDetectOptions } from '../src/core/engine'

const opts = defaultDetectOptions()
const found = (t: string) => detect(t, opts).map((e) => `${e.type}:${e.value}`)

describe('no false positives on ordinary text', () => {
  const clean = [
    '2024-06-01 14:30에 회의가 있습니다. 예산은 1,250,000원입니다.',
    '주문번호 20240601123456 배송 조회는 앱에서 가능합니다.',
    '버전 v2.3.14 배포 완료, 응답시간 120ms 개선',
    '우편번호 06234 / 층수 12층 / 면적 84.5㎡',
    '분기 매출이 전년 대비 12.5% 증가했고 3분기 목표는 450억 원입니다.',
    '고객님께서 문의하신 내용 확인 후 안내드리겠습니다.',
    '사용자님, 관리자님께 권한을 요청해 주세요.',
    '이번 주 금요일까지 보고서를 제출해 주세요. 한국어로 작성하면 됩니다.',
    'const total = items.reduce((a, b) => a + b.price, 0) // sum 1234567890',
    'ISBN 978-89-7914-874-9 도서를 참고하세요.',
    '오늘 서울 날씨는 맑고 최고 기온은 27도입니다.',
    '대표번호 1588-1234로 문의하세요.',
    '정부 지원 사업 공고문을 검토했습니다.',
    '학생들이 조사를 진행하였고 문제가 없었습니다.',
  ]
  for (const t of clean) {
    it(t.slice(0, 20), () => expect(found(t)).toEqual([]))
  }
})

describe('positives in varied formats', () => {
  const cases: Array<[string, string]> = [
    ['휴대폰: 010.1234.5678', 'phone:010.1234.5678'],
    ['010 1234 5678로 연락주세요', 'phone:010 1234 5678'],
    ['(02) 123-4567', 'phone:(02) 123-4567'],
    ['제 번호(02-2345-6789)로 주세요', 'phone:02-2345-6789'],
    ['팩스 031-123-4567', 'phone:031-123-4567'],
    ['+82-10-9876-5432', 'phone:+82-10-9876-5432'],
    ['주민번호: 9001011234568', 'rrn:9001011234568'],
    ['생년월일: 1990년 3월 5일', 'birth:1990년 3월 5일'],
    ['농협 351-1234-5678-93 입금 바랍니다', 'account:351-1234-5678-93'],
    ['토스뱅크 1000-1234-5678', 'account:1000-1234-5678'],
    ['카드번호 5409-2112-3456-7890', 'card:5409-2112-3456-7890'],
    ['서울 강남구 역삼동 823-12', 'address:서울 강남구 역삼동 823-12'],
    ['부산광역시 해운대구 센텀중앙로 79', 'address:부산광역시 해운대구 센텀중앙로 79'],
    ['받는 분: 한지민', 'name:한지민'],
    ['To: Jane Doe', 'name:Jane Doe'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'secret:ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'],
    ['서울12가3456 차량', 'car:서울12가3456'],
  ]
  for (const [t, exp] of cases) it(t, () => expect(found(t)).toContain(exp))
})

describe('demo sample', () => {
  it('masks every personal value in the built-in sample', async () => {
    const { SAMPLE_TEXT } = await import('../src/lib/samples')
    const { applyMask } = await import('../src/core/mask')
    for (const mode of ['token', 'fake', 'redact'] as const) {
      const out = applyMask(SAMPLE_TEXT, detect(SAMPLE_TEXT, opts), new Set(), { mode, tokenLang: 'ko', partialRedact: false }).text
      for (const secret of ['박서준', '정하은', '김민수', '950314', '9876', '2345-6789', 'haeun', '월드컵북로', '456789', '3456', 'abc123def456', 'sk-proj']) {
        expect(out, `${mode}: ${secret}`).not.toContain(secret)
      }
    }
  })
})

describe('name patterns', () => {
  const cases: Array<[string, string]> = [
    ['안녕하세요, 마케팅팀 김민수입니다.', 'name:김민수'],
    ['안녕하세요 이서연입니다', 'name:이서연'],
    ['감사합니다.\n박지훈 드림', 'name:박지훈'],
    ['홍길동(010-1234-5678)에게 연락', 'name:홍길동'],
    ['Please contact Mr. John Smith today', 'name:John Smith'],
    ['정수아 담당자님께 전달했습니다', 'name:정수아'],
  ]
  for (const [t, exp] of cases) it(t, () => expect(found(t)).toContain(exp))
  it('does not flag intro without a name', () => {
    expect(found('안녕하세요, 고객센터입니다.')).toEqual([])
    expect(found('안녕하세요 반갑습니다')).toEqual([])
    expect(found('서울특별시 송파구 올림픽로 300').filter((x) => x.startsWith('name'))).toEqual([])
    expect(found('서울특별시 송파구 010-1234-5678').filter((x) => x.startsWith('name'))).toEqual([])
  })
})

describe('structured data', () => {
  it('json', () => {
    const r = found('{"customer_name": "홍길동", "phone": "010-1111-2222", "email": "gd@x.io", "userName": "Jane Doe"}')
    expect(r).toEqual(expect.arrayContaining(['name:홍길동', 'phone:010-1111-2222', 'email:gd@x.io', 'name:Jane Doe']))
  })
  it('csv rows', () => {
    const r = found('이름,전화,메모\n김하늘,010-2222-3333,VIP\n오세훈,010-4444-5555,')
    expect(r).toEqual(expect.arrayContaining(['name:김하늘', 'name:오세훈']))
  })
  it('english prose after To:', () => {
    expect(found('To: the team, please review').filter((x) => x.startsWith('name'))).toEqual([])
  })
})

describe('id documents and forms', () => {
  it('romanized names', () => {
    expect(found('HANA\nCHOI HYEONGYU')).toContain('name:CHOI HYEONGYU')
    expect(found('CHO) HYEONGYU')).toContain('name:CHO) HYEONGYU')
    expect(found('HONG GIL-DONG')).toContain('name:HONG GIL-DONG')
    expect(found('HANA CARD').filter((x) => x.startsWith('name'))).toEqual([])
    expect(found('KIM CARD').filter((x) => x.startsWith('name'))).toEqual([])
  })
  it('standalone name line on an ID card', () => {
    expect(found('학생증 Student ID Card\n김하늘\n2024123456\n컴퓨터공학과')).toContain('name:김하늘')
    expect(found('회의록\n김하늘\n안건').filter((x) => x.startsWith('name'))).toEqual([])
  })
  it('vehicle registration style form', () => {
    const t = '성 명(명칭) 홍길동\n주민(법인)등록번호 850101-1234567\n사용본거지 경기도 수원시 팔달구 효원로 241\n차대번호 KMHD341ABCU123456'
    const r = found(t)
    expect(r).toContain('name:홍길동')
    expect(r).toContain('rrn:850101-1234567')
    expect(r.some((x) => x.startsWith('address:경기도 수원시 팔달구 효원로 241'))).toBe(true)
    expect(r).toContain('car:KMHD341ABCU123456')
  })
  it('OCR-damaged resident number next to a label', () => {
    expect(found('주민등록번호 851301-1234567')).toContain('rrn:851301-1234567')
  })
})

describe('vehicle registration OCR quirks', () => {
  it('VIN with a stray space and the 소유자 label', () => {
    const r = found('차대번호.\n\nKMHL341CBMA 123456\n소유자\n성명(명칭) 박수현')
    expect(r).toContain('car:KMHL341CBMA 123456')
    expect(r).toContain('name:박수현')
    expect(r.filter((x) => x === 'name:소유자')).toEqual([])
  })
})

describe('romanised names on ID cards with a damaged surname', () => {
  const names = (t: string) => detect(t, opts).filter((e) => e.type === 'name').map((e) => e.value)
  it('covers the given name and the garbled surname before it', () => {
    expect(names('학생증 Student ID Card\nHANA\nHO) HYEONGYU\n')).toContain('HO) HYEONGYU')
    expect(names('학생증\n€©HOY MINJUNG |\n')).toContain('€©HOY MINJUNG')
  })
  it('ignores card words and text outside ID documents', () => {
    expect(names('학생증\nHANA CARD\nVALID THRU 03/29\n')).toEqual([])
    expect(names('학생증\nAHANA\nSHINHAN\n')).toEqual([])
    expect(names('회의록\nHO) HYEONGYU\n')).toEqual([])
  })
})

describe('document nouns are not names', () => {
  it('does not take 계약서/신청서/영수증 next to contact details as names', () => {
    const names = detect('신규 고객 이서연 님(010-2345-6789) 계약서 검토 부탁드립니다. 영수증 010-9876-5432 위임장', opts)
      .filter((e) => e.type === 'name')
      .map((e) => e.value)
    expect(names).toEqual(['이서연'])
  })
})
