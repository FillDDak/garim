import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultDetectOptions } from '../core/engine'
import { mergeMapping } from '../core/mask'
import type { DetectOptions, EntityType, MappingEntry, MaskOptions } from '../core/types'
import { clearAll, load, save } from '../lib/storage'
import { newSession, pruneSessions, sessionTitle, type Retention, type Session } from '../lib/sessions'

export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  detect: DetectOptions
  mask: MaskOptions
  retention: Retention
  addNotice: boolean
  theme: Theme
  /** Image redaction style */
  imageStyle: 'black' | 'pixelate' | 'blur' | 'white'
}

export const defaultSettings = (): Settings => ({
  detect: defaultDetectOptions(),
  mask: { mode: 'token', tokenLang: 'ko', partialRedact: true },
  retention: '24h',
  addNotice: true,
  theme: 'system',
  imageStyle: 'black',
})

function loadSettings(): Settings {
  const base = defaultSettings()
  const stored = load<Partial<Settings>>('settings', {})
  return {
    ...base,
    ...stored,
    detect: {
      ...base.detect,
      ...(stored.detect ?? {}),
      enabled: { ...base.detect.enabled, ...(stored.detect?.enabled ?? {}) } as Record<EntityType, boolean>,
    },
    mask: { ...base.mask, ...(stored.mask ?? {}) },
  }
}

function readSessions(retention: Retention): Session[] {
  if (retention === 'tab') {
    try {
      const raw = sessionStorage.getItem('garim:sessions')
      return raw ? (JSON.parse(raw) as Session[]) : []
    } catch {
      return []
    }
  }
  return pruneSessions(load<Session[]>('sessions', []), retention)
}

function writeSessions(sessions: Session[], retention: Retention) {
  if (retention === 'tab') {
    try {
      sessionStorage.setItem('garim:sessions', JSON.stringify(sessions))
    } catch {
      /* ignore */
    }
    save('sessions', [])
    return
  }
  save('sessions', sessions)
}

export interface Toast {
  id: number
  message: string
  tone: 'default' | 'success' | 'warn'
}

interface AppStateValue {
  settings: Settings
  updateSettings: (patch: Partial<Settings> | ((s: Settings) => Settings)) => void
  resetSettings: () => void
  sessions: Session[]
  activeSession: Session
  setActiveSessionId: (id: string) => void
  /** Merge mapping entries into the active session (creating a title from `sourceText`). */
  commitMapping: (entries: MappingEntry[], sourceText?: string) => void
  startNewSession: () => void
  deleteSession: (id: string) => void
  importSessions: (list: Session[]) => void
  wipeEverything: () => void
  toast: (message: string, tone?: Toast['tone']) => void
  toasts: Toast[]
  /** Text handed over from other views (share target, file → text). */
  pendingText: string | null
  setPendingText: (t: string | null) => void
}

const Ctx = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [sessions, setSessions] = useState<Session[]>(() => readSessions(loadSettings().retention))
  const [activeId, setActiveId] = useState<string>(() => load<string>('activeSession', ''))
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pendingText, setPendingText] = useState<string | null>(null)
  const toastSeq = useRef(0)

  // make sure there is always an active session
  const activeSession = useMemo(() => sessions.find((s) => s.id === activeId), [sessions, activeId])
  useEffect(() => {
    if (!activeSession) {
      const s = newSession()
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
    }
  }, [activeSession])

  useEffect(() => save('settings', settings), [settings])
  useEffect(() => writeSessions(sessions, settings.retention), [sessions, settings.retention])
  useEffect(() => save('activeSession', activeId), [activeId])

  // periodic retention pruning
  useEffect(() => {
    const t = window.setInterval(() => setSessions((prev) => {
      const next = pruneSessions(prev, settings.retention)
      return next.length === prev.length ? prev : next
    }), 60_000)
    return () => window.clearInterval(t)
  }, [settings.retention])

  // theme
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  const updateSettings = useCallback((patch: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettings((prev) => (typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }))
  }, [])

  const toast = useCallback((message: string, tone: Toast['tone'] = 'default') => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600)
  }, [])

  const commitMapping = useCallback(
    (entries: MappingEntry[], sourceText?: string) => {
      if (!entries.length) return
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? {
                ...s,
                title: s.title || (sourceText ? sessionTitle(sourceText) : '제목 없음'),
                mapping: mergeMapping(s.mapping, entries.filter((e) => e.mode !== 'redact')),
                updatedAt: Date.now(),
              }
            : s,
        ),
      )
    },
    [activeId],
  )

  const startNewSession = useCallback(() => {
    const s = newSession()
    setSessions((prev) => [s, ...prev.filter((x) => x.mapping.length > 0)])
    setActiveId(s.id)
  }, [])

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const importSessions = useCallback((list: Session[]) => {
    setSessions((prev) => {
      const ids = new Set(prev.map((s) => s.id))
      return [...list.filter((s) => !ids.has(s.id)), ...prev]
    })
  }, [])

  const wipeEverything = useCallback(() => {
    clearAll()
    try {
      sessionStorage.clear()
    } catch {
      /* ignore */
    }
    const s = newSession()
    setSettings(defaultSettings())
    setSessions([s])
    setActiveId(s.id)
  }, [])

  const value: AppStateValue = {
    settings,
    updateSettings,
    resetSettings: () => setSettings(defaultSettings()),
    sessions,
    activeSession: activeSession ?? sessions[0] ?? newSession(),
    setActiveSessionId: setActiveId,
    commitMapping,
    startNewSession,
    deleteSession,
    importSessions,
    wipeEverything,
    toast,
    toasts,
    pendingText,
    setPendingText,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppStateValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}
