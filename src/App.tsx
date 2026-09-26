import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FileText, Image as ImageIcon, Info, Loader2, Moon, Settings2, ShieldCheck, Sun, TriangleAlert, Undo2, WifiOff, X } from 'lucide-react'
import { AppStateProvider, useApp } from './state/AppState'
import { Logo } from './components/Logo'
import { TextView } from './views/TextView'
import { RestoreView } from './views/RestoreView'
import { SettingsView } from './views/SettingsView'
import { GuideView } from './views/GuideView'

const FileView = lazy(() => import('./views/FileView').then((m) => ({ default: m.FileView })))
const ImageView = lazy(() => import('./views/ImageView').then((m) => ({ default: m.ImageView })))

type Route = 'text' | 'restore' | 'files' | 'image' | 'settings' | 'guide'

const NAV: Array<{ id: Route; label: string; short: string; icon: React.ReactNode }> = [
  { id: 'text', label: '텍스트 가리기', short: '가리기', icon: <ShieldCheck size={17} /> },
  { id: 'restore', label: '되돌리기', short: '되돌리기', icon: <Undo2 size={17} /> },
  { id: 'files', label: '문서', short: '문서', icon: <FileText size={17} /> },
  { id: 'image', label: '이미지', short: '이미지', icon: <ImageIcon size={17} /> },
  { id: 'settings', label: '설정', short: '설정', icon: <Settings2 size={17} /> },
]

const ROUTES: Route[] = ['text', 'restore', 'files', 'image', 'settings', 'guide']

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '') as Route
  return ROUTES.includes(h) ? h : 'text'
}

function Shell() {
  const { settings, updateSettings, toasts, setPendingText } = useApp()
  const [route, setRoute] = useState<Route>(readRoute)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [introHidden, setIntroHidden] = useState(() => {
    try {
      return localStorage.getItem('garim:intro') === '1'
    } catch {
      return false
    }
  })

  const go = useCallback((r: string) => {
    const next = (ROUTES.includes(r as Route) ? r : 'text') as Route
    if (window.location.hash !== `#/${next}`) window.history.pushState(null, '', `#/${next}`)
    setRoute(next)
    window.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    window.addEventListener('popstate', onHash)
    window.addEventListener('hashchange', onHash)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('popstate', onHash)
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Web Share Target (installed PWA on Android): ?text=...&title=...&url=...
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const shared = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n')
    if (shared) {
      setPendingText(shared)
      window.history.replaceState(null, '', window.location.pathname + '#/text')
      setRoute('text')
    }
  }, [setPendingText])

  // Alt+1..5 navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault()
        go(NAV[n - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  useEffect(() => {
    const title = route === 'guide' ? '소개' : NAV.find((n) => n.id === route)?.label
    document.title = title && route !== 'text' ? `${title} · 가림` : '가림 — AI에 보내기 전 개인정보 가리기'
  }, [route])

  const isDark =
    settings.theme === 'dark' || (settings.theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const hideIntro = () => {
    setIntroHidden(true)
    try {
      localStorage.setItem('garim:intro', '1')
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <button type="button" className="brand" onClick={() => go('text')} aria-label="가림 홈">
            <Logo />
            <span className="brand-text">
              <span className="brand-name">가림</span>
              <span className="brand-sub">AI에 보내기 전 개인정보 가리기</span>
            </span>
          </button>
          <nav className="nav" aria-label="주요 메뉴">
            {NAV.map((n) => (
              <button key={n.id} type="button" className={`nav-item ${route === n.id ? 'active' : ''}`} onClick={() => go(n.id)} aria-current={route === n.id ? 'page' : undefined}>
                {n.icon}
                <span className="nav-label">{n.label}</span>
                <span className="nav-short">{n.short}</span>
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <button
              type="button"
              className={`privacy-pill ${online ? '' : 'offline'}`}
              onClick={() => go('guide')}
              title="모든 처리는 이 기기 안에서 이뤄지며, 보안 정책(CSP)으로 외부 전송이 차단되어 있어요"
            >
              {online ? <ShieldCheck size={15} /> : <WifiOff size={15} />}
              <span>{online ? '서버 전송 0' : '오프라인 동작 중'}</span>
            </button>
            <button type="button" className="icon-btn big" onClick={() => go('guide')} aria-label="소개 및 도움말" title="소개 및 도움말">
              <Info size={18} />
            </button>
            <button
              type="button"
              className="icon-btn big"
              onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
              aria-label={isDark ? '라이트 모드로' : '다크 모드로'}
              title={isDark ? '라이트 모드로' : '다크 모드로'}
            >
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="main">
        {route === 'text' && !introHidden && (
          <div className="intro">
            <div className="intro-text">
              <strong>ChatGPT·Claude에 붙여넣기 전, 개인정보를 자동으로 가리고 답변은 원래대로 되돌려요.</strong>
              <span>입력한 글은 이 브라우저 밖으로 절대 나가지 않아요. 인터넷을 꺼도 동작합니다.</span>
            </div>
            <div className="intro-actions">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  go('guide')
                  window.setTimeout(() => document.getElementById('extension')?.scrollIntoView({ behavior: 'smooth' }), 80)
                }}
              >
                브라우저 확장
              </button>
              <button type="button" className="link-btn" onClick={() => go('guide')}>
                작동 방식
              </button>
              <button type="button" className="icon-btn" onClick={hideIntro} aria-label="안내 닫기">
                <X size={16} />
              </button>
            </div>
          </div>
        )}
        {route === 'text' && <TextView goRestore={() => go('restore')} />}
        {route === 'restore' && <RestoreView />}
        <Suspense
          fallback={
            <div className="loading">
              <Loader2 className="spin" size={22} />
            </div>
          }
        >
          {route === 'files' && (
            <FileView
              openInText={(t) => {
                setPendingText(t)
                go('text')
              }}
            />
          )}
          {route === 'image' && <ImageView />}
        </Suspense>
        {route === 'settings' && <SettingsView />}
        {route === 'guide' && <GuideView go={go} />}
      </main>

      <footer className="footer">
        <span>
          <ShieldCheck size={14} /> 모든 처리는 이 기기에서만 · 오픈소스 ·{' '}
          <a href="https://github.com/FillDDak/what" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
        <span className="muted">가림은 실수를 줄여 주는 도구예요. 보내기 전에 결과를 한 번 확인해 주세요.</span>
      </footer>

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'success' ? <CheckCircle2 size={17} /> : t.tone === 'warn' ? <TriangleAlert size={17} /> : <Info size={17} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  )
}
