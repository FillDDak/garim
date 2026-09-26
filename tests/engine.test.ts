import { describe, expect, it } from 'vitest'
import { detect, defaultDetectOptions } from '../src/core/engine'
import { applyMask } from '../src/core/mask'
import { restore } from '../src/core/restore'
import type { EntityType } from '../src/core/types'

const opts = defaultDetectOptions()
const types = (text: string) => detect(text, opts).map((e) => [e.type, e.value] as [EntityType, string])

describe('detect', () => {
  it('finds resident registration numbers', () => {
    expect(types('주민번호 900101-1234568 입니다')).toContainEqual(['rrn', '900101-1234568'])
    expect(types('외국인 900101-5234567')).toContainEqual(['frn', '900101-5234567'])
    expect(types('880230-1234567')).toEqual([]) // invalid date
    expect(types('900101-1******')).toContainEqual(['rrn', '900101-1******'])
  })
  it('finds phones', () => {
    expect(types('연락처: 010-1234-5678')).toContainEqual(['phone', '010-1234-5678'])
    expect(types('01012345678로 전화')).toContainEqual(['phone', '01012345678'])
    expect(types('+82 10-1234-5678')).toContainEqual(['phone', '+82 10-1234-5678'])
    expect(types('사무실 02-123-4567')).toContainEqual(['phone', '02-123-4567'])
    expect(types('031)123-4567')).toContainEqual(['phone', '031)123-4567'])
    expect(types('2024-01-15')).toEqual([])
  })
  it('finds emails, cards, accounts', () => {
    expect(types('mail me at hong.gd@example.co.kr')).toContainEqual(['email', 'hong.gd@example.co.kr'])
    expect(types('카드 4111-1111-1111-1111')).toContainEqual(['card', '4111-1111-1111-1111'])
    expect(types('주문번호 1234-5678-1234-5678')).toEqual([])
    expect(types('국민은행 123456-01-123456 (예금주 홍길동)')).toEqual(
      expect.arrayContaining([
        ['account', '123456-01-123456'],
        ['name', '홍길동'],
      ]),
    )
    expect(types('카카오뱅크 3333-01-1234567로 입금')).toContainEqual(['account', '3333-01-1234567'])
  })
  it('finds business numbers', () => {
    expect(types('사업자등록번호 220-81-62517')).toContainEqual(['bizno', '220-81-62517'])
  })
  it('finds names by context', () => {
    expect(types('김민수 과장님께 전달 부탁드립니다')).toContainEqual(['name', '김민수'])
    expect(types('성명: 이서연')).toContainEqual(['name', '이서연'])
    expect(types('홍길동 010-1111-2222')).toContainEqual(['name', '홍길동'])
    expect(types('고객님께 안내드립니다')).toEqual([])
    expect(types('사용자님 안녕하세요')).toEqual([])
    expect(types('남궁민수님이 오셨어요')).toContainEqual(['name', '남궁민수'])
    expect(types('박지훈씨가 왔다')).toContainEqual(['name', '박지훈'])
  })
  it('propagates names', () => {
    const t = types('담당자: 최유진\n최유진에게 다시 연락드리겠습니다.')
    expect(t.filter(([ty]) => ty === 'name')).toHaveLength(2)
  })
  it('finds addresses', () => {
    const a = types('주소는 서울특별시 강남구 테헤란로 123, 4층 입니다')
    expect(a.find(([t]) => t === 'address')?.[1]).toContain('서울특별시 강남구 테헤란로 123')
    const b = types('경기도 성남시 분당구 판교역로 235 에이치스퀘어 N동 7층')
    expect(b.find(([t]) => t === 'address')?.[1]).toContain('판교역로 235')
    const c = types('래미안아파트 101동 1203호')
    expect(c.find(([t]) => t === 'address')).toBeTruthy()
  })
  it('finds secrets', () => {
    expect(types('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456')[0][0]).toBe('secret')
    expect(types('password: hunter22!')).toContainEqual(['secret', 'hunter22!'])
    expect(types('비밀번호: qwer1234')).toContainEqual(['secret', 'qwer1234'])
    expect(types('Authorization: Bearer abcdefghijklmnop1234567890')).toContainEqual(['secret', 'abcdefghijklmnop1234567890'])
    expect(types('postgres://admin:s3cr3t@db.local:5432/app')).toContainEqual(['secret', 's3cr3t'])
    expect(types('AKIAIOSFODNN7EXAMPLE')).toContainEqual(['secret', 'AKIAIOSFODNN7EXAMPLE'])
  })
  it('finds ip, car, passport, driver', () => {
    expect(types('서버 192.168.0.12 접속')).toContainEqual(['ip', '192.168.0.12'])
    expect(types('차량번호 12가 3456')).toContainEqual(['car', '12가 3456'])
    expect(types('여권번호 M12345678')).toContainEqual(['passport', 'M12345678'])
    expect(types('면허번호 11-12-123456-12')).toContainEqual(['driver', '11-12-123456-12'])
  })
  it('respects allow list and custom terms', () => {
    const o = { ...defaultDetectOptions(), allowList: ['02-123-4567'], customTerms: [{ id: '1', text: '프로젝트 오로라', label: '프로젝트' }] }
    const r = detect('대표번호 02-123-4567, 프로젝트 오로라 일정', o)
    expect(r.map((e) => e.type)).toEqual(['custom'])
  })
})

describe('mask + restore', () => {
  const text = '김민수 과장님(010-1234-5678, minsu@corp.com)께 김민수 과장님 자료를 보내주세요. 01012345678'
  it('token mode is consistent and reversible', () => {
    const ents = detect(text, opts)
    const r = applyMask(text, ents, new Set(), { mode: 'token', tokenLang: 'ko', partialRedact: true })
    expect(r.text).toBe('[이름_1] 과장님([전화_1], [이메일_1])께 [이름_1] 과장님 자료를 보내주세요. [전화_1]')
    const answer = '【이름 1】 과장님께는 [전화_1]로 연락하고 이메일_1 로 메일을 보내세요. \\[이름_1\\]'
    const back = restore(answer, r.mapping)
    expect(back.text).toBe('김민수 과장님께는 010-1234-5678로 연락하고 minsu@corp.com 로 메일을 보내세요. 김민수')
  })
  it('fake mode is reversible', () => {
    const ents = detect(text, opts)
    const r = applyMask(text, ents, new Set(), { mode: 'fake', tokenLang: 'ko', partialRedact: true })
    expect(r.text).not.toContain('김민수')
    expect(r.text).toContain('010-0000-1001')
    const back = restore(r.text.replace('010-0000-1001', '01000001001'), r.mapping)
    expect(back.text).not.toContain('0000')
    expect(back.text).toContain('김민수')
  })
  it('redact mode masks partially', () => {
    const ents = detect(text, opts)
    const r = applyMask(text, ents, new Set(), { mode: 'redact', tokenLang: 'ko', partialRedact: true })
    expect(r.text).toContain('김*수')
    expect(r.text).toContain('010-****-5678')
    expect(r.text).toContain('mi***@corp.com')
  })
  it('flags unknown placeholders', () => {
    const back = restore('[이름_9] 입니다', [])
    expect(back.unknown).toEqual(['[이름_9]'])
  })
})
