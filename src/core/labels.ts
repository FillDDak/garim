import type { EntityType, TokenLang } from './types'

export interface TypeMeta {
  /** Display name in the UI. */
  name: string
  /** Placeholder label (Korean). */
  ko: string
  /** Placeholder label (English). */
  en: string
  /** Grouping for colours. */
  group: 'person' | 'contact' | 'id' | 'finance' | 'location' | 'tech' | 'custom'
  description: string
}

export const TYPE_META: Record<EntityType, TypeMeta> = {
  name: { name: '이름', ko: '이름', en: 'NAME', group: 'person', description: '호칭·항목명·연락처 주변 문맥으로 사람 이름을 찾습니다' },
  rrn: { name: '주민등록번호', ko: '주민번호', en: 'RRN', group: 'id', description: '생년월일 유효성과 체크섬으로 검증합니다' },
  frn: { name: '외국인등록번호', ko: '외국인번호', en: 'FRN', group: 'id', description: '성별 자리 5~8 형식' },
  phone: { name: '전화번호', ko: '전화', en: 'PHONE', group: 'contact', description: '휴대전화·유선·070·+82 국제번호' },
  email: { name: '이메일', ko: '이메일', en: 'EMAIL', group: 'contact', description: '모든 이메일 주소' },
  address: { name: '주소', ko: '주소', en: 'ADDRESS', group: 'location', description: '도로명·지번 주소와 동·호수' },
  account: { name: '계좌번호', ko: '계좌', en: 'ACCOUNT', group: 'finance', description: '은행명·입금·송금 등 문맥이 있는 계좌' },
  card: { name: '카드번호', ko: '카드', en: 'CARD', group: 'finance', description: 'Luhn 알고리즘으로 검증된 카드번호' },
  birth: { name: '생년월일', ko: '생년월일', en: 'DOB', group: 'person', description: '생년월일·생일 항목의 날짜' },
  bizno: { name: '사업자등록번호', ko: '사업자번호', en: 'BIZNO', group: 'id', description: '국세청 체크섬 검증' },
  corpno: { name: '법인등록번호', ko: '법인번호', en: 'CORPNO', group: 'id', description: '법인등록번호 체크섬 검증' },
  passport: { name: '여권번호', ko: '여권', en: 'PASSPORT', group: 'id', description: '구형·신형 대한민국 여권번호' },
  driver: { name: '운전면허번호', ko: '면허', en: 'LICENSE', group: 'id', description: '지역코드-연도-일련번호 형식' },
  car: { name: '차량번호', ko: '차량', en: 'PLATE', group: 'id', description: '12가3456 · 서울12가3456 형식' },
  ip: { name: 'IP 주소', ko: 'IP', en: 'IP', group: 'tech', description: 'IPv4 · IPv6 주소' },
  secret: { name: 'API 키·비밀번호', ko: '비밀키', en: 'SECRET', group: 'tech', description: 'OpenAI·AWS·GitHub 키, JWT, 비밀번호 값 등' },
  url: { name: '민감 URL', ko: 'URL', en: 'URL', group: 'tech', description: '토큰·이메일이 쿼리에 담긴 링크' },
  custom: { name: '내 사전', ko: '가림', en: 'HIDDEN', group: 'custom', description: '직접 등록한 단어·정규식' },
}

export const tokenLabel = (type: EntityType, lang: TokenLang, custom?: string) =>
  type === 'custom' && custom ? custom : TYPE_META[type][lang]
