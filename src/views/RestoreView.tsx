import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, ClipboardPaste, Copy, Download, Eraser, History, KeyRound, Trash2, Undo2, Upload } from 'lucide-react'
import { TYPE_META } from '../core/labels'
import { restore } from '../core/restore'
import { Button, Card, CardHeader, Empty } from '../components/ui'
import { useApp } from '../state/AppState'
import { copyText, downloadText, readText } from '../lib/clipboard'
import { formatTime, type Session } from '../lib/sessions'
import { SAMPLE_AI_ANSWER_SOURCE, SAMPLE_TEXT } from '../lib/samples'
import { detect } from '../core/engine'
import { applyMask } from '../core/mask'
import type { MaskOptions } from '../core/types'

export function RestoreView() {
  const { settings, sessions, activeSession, setActiveSessionId, deleteSession, importSessions, commitMapping, toast } = useApp()
  const [input, setInput] = useState('')
  const [showMap, setShowMap] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  const visibleSessions = sessions.filter((s) => s.mapping.length > 0 || s.id === activeSession.id)
  const result = useMemo(() => restore(input, activeSession.mapping), [input, activeSession.mapping])
  const reversible = activeSession.mapping.filter((m) => m.mode !== 'redact')

  const loadDemo = () => {
    const opts: MaskOptions = { ...settings.mask, mode: settings.mask.mode === 'redact' ? 'token' : settings.mask.mode }
    const src = applyMask(SAMPLE_TEXT, detect(SAMPLE_TEXT, settings.detect), new Set(), opts, activeSession.mapping)
    commitMapping(src.mapping, SAMPLE_TEXT)
    const prior = [...activeSession.mapping, ...src.mapping]
    const answer = applyMask(SAMPLE_AI_ANSWER_SOURCE, detect(SAMPLE_AI_ANSWER_SOURCE, settings.detect), new Set(), opts, prior)
    setInput(answer.text)
    toast('예시 원문을 가린 뒤 받은 AI 답변이라고 가정한 글이에요')
  }

  const doCopy = async () => {
    if (await copyText(result.text)) toast('원래 값으로 되돌린 글을 복사했어요', 'success')
  }

  const exportSession = (s: Session) => {
    downloadText(JSON.stringify({ app: 'garim', version: 1, sessions: [s] }, null, 2), `가림-복원키-${new Date(s.createdAt).toISOString().slice(0, 10)}.json`, 'application/json')
    toast('복원 키 파일에는 원래 개인정보가 들어 있어요. 안전한 곳에 보관하세요', 'warn')
  }

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as { app?: string; sessions?: Session[] }
      if (data.app !== 'garim' || !Array.isArray(data.sessions)) throw new Error('bad')
      const valid = data.sessions.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.mapping))
      importSessions(valid)
      if (valid[0]) setActiveSessionId(valid[0].id)
      toast(`${valid.length}개 세션을 불러왔어요`, 'success')
    } catch {
      toast('가림 복원 키 파일(.json)이 아니에요', 'warn')
    }
  }

  const rendered = useMemo(
    () =>
      result.segments.map((s, i) =>
        s.kind === 'text' ? (
          s.text
        ) : s.kind === 'restored' ? (
          <mark key={i} className={`chip static g-${TYPE_META[s.type].group}`} title={`${s.replacement} → ${s.text}`}>
            {s.text}
          </mark>
        ) : (
          <mark key={i} className="chip static unknown" title="이 자리표시자는 현재 세션에 없어요">
            {s.text}
          </mark>
        ),
      ),
    [result.segments],
  )

  return (
    <div className="view restore-view">
      <div className="restore-grid">
        <Card className="pane">
          <CardHeader
            title="AI 답변 붙여넣기"
            subtitle="[이름_1] 같은 자리표시자나 가짜 값이 원래 값으로 돌아와요"
            icon={<Undo2 size={18} />}
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ClipboardPaste size={15} />}
                  onClick={async () => {
                    const c = await readText()
                    if (c != null) setInput(c)
                    else toast('Ctrl+V로 붙여넣어 주세요', 'warn')
                  }}
                >
                  붙여넣기
                </Button>
                <Button size="sm" variant="ghost" icon={<Eraser size={15} />} onClick={() => setInput('')} disabled={!input} title="지우기" />
              </>
            }
          />
          <div className="pane-body">
            <textarea
              className="plain-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              aria-label="AI 답변"
              placeholder={'ChatGPT·Claude·Gemini 등에서 받은 답변을 붙여넣으세요.\n\nAI가 [이름 1], 【이름_1】, 이름_1 처럼 표기를 살짝 바꿔도 알아서 찾아 복원합니다.'}
            />
          </div>
          <footer className="pane-foot">
            <span className="muted">
              {reversible.length ? (
                <>
                  현재 세션의 복원 키 <b>{reversible.length}</b>개 사용 중
                </>
              ) : (
                '아직 이 세션에서 가린 기록이 없어요'
              )}
            </span>
            {!input && reversible.length === 0 && (
              <button type="button" className="link-btn" onClick={loadDemo}>
                예시 답변 보기
              </button>
            )}
          </footer>
        </Card>

        <Card className="pane">
          <CardHeader
            title="원래대로 되돌린 결과"
            subtitle={input ? (result.restored ? `${result.restored}곳을 되돌렸어요` : '되돌릴 표시를 찾지 못했어요') : undefined}
            icon={<KeyRound size={18} />}
          />
          <div className="pane-body">
            <div className="preview">
              {input ? (
                rendered
              ) : (
                <Empty icon={<Undo2 size={28} />} title="AI 답변을 왼쪽에 붙여넣으세요">
                  가린 원문을 복사할 때 저장된 ‘복원 키’로 이 기기 안에서만 되돌립니다.
                </Empty>
              )}
            </div>
          </div>
          <footer className="pane-foot output-foot">
            <div className="foot-left">
              {result.unknown.length > 0 && (
                <span className="warn-text">
                  <AlertTriangle size={14} /> 세션에 없는 표시 {result.unknown.length}개: {result.unknown.slice(0, 3).join(', ')}
                </span>
              )}
            </div>
            <div className="foot-right">
              <Button variant="primary" size="lg" icon={<Copy size={17} />} onClick={doCopy} disabled={!input}>
                복사하기
              </Button>
            </div>
          </footer>
        </Card>
      </div>

      <Card className="sessions-card">
        <CardHeader
          title="복원 키 보관함"
          subtitle="가린 글을 복사할 때마다 원래 값과의 연결이 이 기기에만 저장돼요. 보관 기간은 설정에서 바꿀 수 있어요"
          icon={<History size={18} />}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<Upload size={15} />} onClick={() => importRef.current?.click()}>
                불러오기
              </Button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void importFile(f)
                  e.target.value = ''
                }}
              />
            </>
          }
        />
        <div className="sessions">
          {visibleSessions.map((s) => {
            const on = s.id === activeSession.id
            return (
              <div key={s.id} className={`session ${on ? 'active' : ''}`}>
                <button type="button" className="session-main" onClick={() => setActiveSessionId(s.id)} aria-pressed={on}>
                  <span className="session-title">{s.title || (on ? '현재 세션' : '제목 없음')}</span>
                  <span className="session-meta">
                    {formatTime(s.updatedAt)} · 키 {s.mapping.length}개{on ? ' · 사용 중' : ''}
                  </span>
                </button>
                <div className="session-actions">
                  {on && s.mapping.length > 0 && (
                    <button type="button" className="icon-btn" onClick={() => setShowMap((v) => !v)} title="복원 키 보기">
                      <KeyRound size={15} />
                    </button>
                  )}
                  {s.mapping.length > 0 && (
                    <button type="button" className="icon-btn" onClick={() => exportSession(s)} title="복원 키 파일로 저장">
                      <Download size={15} />
                    </button>
                  )}
                  {s.mapping.length > 0 && (
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => {
                        if (confirm('이 세션의 복원 키를 삭제할까요? 삭제하면 이 세션에서 가린 답변은 되돌릴 수 없어요.')) deleteSession(s.id)
                      }}
                      title="삭제"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {showMap && reversible.length > 0 && (
          <div className="map-table-wrap">
            <table className="map-table">
              <thead>
                <tr>
                  <th>유형</th>
                  <th>AI에게 보낸 값</th>
                  <th>원래 값</th>
                </tr>
              </thead>
              <tbody>
                {reversible.map((m) => (
                  <tr key={m.mode + m.key}>
                    <td>
                      <span className={`tag g-${TYPE_META[m.type].group}`}>{m.type === 'custom' ? m.label : TYPE_META[m.type].name}</span>
                    </td>
                    <td className="mono">{m.replacement}</td>
                    <td className="mono">{m.original}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
