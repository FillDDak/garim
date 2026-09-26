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
