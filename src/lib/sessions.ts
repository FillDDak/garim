import type { MappingEntry } from '../core/types'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  mapping: MappingEntry[]
}

export type Retention = 'tab' | '1h' | '24h' | '7d' | 'forever'

export const RETENTION_LABEL: Record<Retention, string> = {
  tab: '저장 안 함 (탭을 닫으면 삭제)',
  '1h': '1시간 후 자동 삭제',
  '24h': '24시간 후 자동 삭제',
  '7d': '7일 후 자동 삭제',
  forever: '직접 지울 때까지 보관',
}

const RETENTION_MS: Record<Retention, number> = {
  tab: 0,
  '1h': 3600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  forever: Number.POSITIVE_INFINITY,
}

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export function newSession(): Session {
  const now = Date.now()
  return { id: newId(), title: '', createdAt: now, updatedAt: now, mapping: [] }
}

export function pruneSessions(sessions: Session[], retention: Retention, now = Date.now()): Session[] {
  const ttl = RETENTION_MS[retention]
  if (!Number.isFinite(ttl)) return sessions
  return sessions.filter((s) => now - s.updatedAt < ttl)
}

export function sessionTitle(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return '제목 없음'
  return line.length > 40 ? line.slice(0, 40) + '…' : line
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `오늘 ${hh}:${mm}`
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`
}
