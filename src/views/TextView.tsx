import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ClipboardPaste,
  Copy,
  Eraser,
  EyeOff,
  FileUp,
  Info,
  ListChecks,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
  Zap,
} from 'lucide-react'
import { detect } from '../core/engine'
import { TYPE_META } from '../core/labels'
import { AI_NOTICE, applyMask, entityKey } from '../core/mask'
import type { CustomTerm, Entity, MaskMode } from '../core/types'
import { HighlightEditor, type HighlightEditorHandle } from '../components/HighlightEditor'
import { EntityPanel } from '../components/EntityPanel'
import { Button, Card, CardHeader, Segmented } from '../components/ui'
import { useApp } from '../state/AppState'
import { copyText, readText } from '../lib/clipboard'
import { SAMPLE_TEXT } from '../lib/samples'
import { newId, formatTime } from '../lib/sessions'
import { decodeTextFile, isPlainTextFile } from '../lib/files/text'

const MODE_OPTIONS: Array<{ value: MaskMode; label: string; hint: string }> = [
  { value: 'token', label: '자리표시자', hint: '[이름_1]처럼 바꿔 AI 답변을 원래대로 되돌릴 수 있어요' },
  { value: 'fake', label: '가짜 값', hint: '자연스러운 가상의 값으로 바꾸고 나중에 되돌릴 수 있어요' },
  { value: 'redact', label: '영구 가림', hint: '김*수, 010-****-5678처럼 되돌릴 수 없게 가려요' },
]

const MODE_DESC: Record<MaskMode, string> = {
  token: 'AI에게 보낼 때 추천. [이름_1] 같은 표시로 바꾸고, AI 답변을 받으면 ‘되돌리기’에서 원래 값으로 복원합니다.',
  fake: '문장이 자연스러워야 할 때. 가상의 이름·번호로 바꾸며 이 값들도 되돌리기에서 복원됩니다.',
  redact: '문서·캡처를 외부에 공유할 때. 일부만 보이게 가리며 되돌릴 수 없습니다.',
}

let draftCache = ''
try {
  draftCache = sessionStorage.getItem('garim:draft') ?? ''
} catch {
  /* ignore */
}

export function TextView({ goRestore }: { goRestore: () => void }) {
  const { settings, updateSettings, activeSession, commitMapping, startNewSession, toast, pendingText, setPendingText } = useApp()
  const [text, setText] = useState(draftCache)
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(new Set())
  const [sessionTerms, setSessionTerms] = useState<CustomTerm[]>([])
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [showPanel, setShowPanel] = useState(true)
  const [manualWord, setManualWord] = useState('')
  const [copied, setCopied] = useState(false)
  const editorRef = useRef<HighlightEditorHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const deferred = useDeferredValue(text)

  useEffect(() => setCopied(false), [text, settings.mask.mode])

  useEffect(() => {
    try {
      sessionStorage.setItem('garim:draft', text)
    } catch {
      /* ignore */
    }
    draftCache = text
  }, [text])

  useEffect(() => {
    if (pendingText != null) {
      setText(pendingText)
      setPendingText(null)
    }
  }, [pendingText, setPendingText])

  const detectOpts = useMemo(
    () => ({ ...settings.detect, customTerms: [...settings.detect.customTerms, ...sessionTerms] }),
    [settings.detect, sessionTerms],
  )
  const entities = useMemo(() => detect(deferred, detectOpts), [deferred, detectOpts])
  const keyOf = useCallback((e: Entity) => entityKey(e.type, e.value, e.label), [])
  const isDisabled = useCallback((e: Entity) => disabledKeys.has(keyOf(e)), [disabledKeys, keyOf])
  const disabledIds = useMemo(() => new Set(entities.filter(isDisabled).map((e) => e.id)), [entities, isDisabled])
  const result = useMemo(
    () => applyMask(deferred, entities, disabledIds, settings.mask, activeSession.mapping),
    [deferred, entities, disabledIds, settings.mask, activeSession.mapping],
  )
  const replacementById = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of result.segments) if (s.kind === 'mask') m.set(s.entityId, s.text)
    return m
  }, [result])
  const replacementByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) {
      const r = replacementById.get(e.id)
      if (r) m.set(keyOf(e), r)
    }
    return m
  }, [entities, replacementById, keyOf])

  const withNotice = settings.addNotice && settings.mask.mode === 'token' && result.mapping.length > 0
  const output = (withNotice ? AI_NOTICE[settings.mask.tokenLang] : '') + result.text
  const maskedCount = entities.length - disabledIds.size
  const typeCount = Object.keys(result.counts).length

  const toggleKeys = useCallback((keys: string[], enable: boolean) => {
    setDisabledKeys((prev) => {
      const n = new Set(prev)
      for (const k of keys) {
        if (enable) n.delete(k)
        else n.add(k)
      }
      return n
    })
  }, [])

  const doCopy = useCallback(async () => {
    if (!text.trim()) {
      toast('먼저 가릴 글을 입력해 주세요', 'warn')
      return
    }
    // the preview may lag a frame behind typing (deferred render): always copy the latest text
    let finalText = output
    let finalMapping = result.mapping
    if (deferred !== text) {
      const ents = detect(text, detectOpts)
      const ids = new Set(ents.filter(isDisabled).map((e) => e.id))
      const r = applyMask(text, ents, ids, settings.mask, activeSession.mapping)
      finalText = (settings.addNotice && settings.mask.mode === 'token' && r.mapping.length ? AI_NOTICE[settings.mask.tokenLang] : '') + r.text
      finalMapping = r.mapping
    }
    const ok = await copyText(finalText)
    if (ok) {
      commitMapping(finalMapping, text)
      setCopied(true)
      toast(
        settings.mask.mode === 'redact'
          ? '가린 글을 복사했어요'
          : `복사했어요 · AI 답변은 ‘되돌리기’에 붙여넣으면 원래대로 돌아와요`,
        'success',
      )
    } else toast('복사에 실패했어요. 결과 영역을 직접 선택해 복사해 주세요', 'warn')
  }, [text, deferred, output, commitMapping, result.mapping, detectOpts, isDisabled, settings.mask, settings.addNotice, activeSession.mapping, toast])

  const quickClipboard = useCallback(async () => {
    const clip = await readText()
    if (clip == null) {
      toast('브라우저가 클립보드 읽기를 허용하지 않았어요. Ctrl+V로 붙여넣어 주세요', 'warn')
      editorRef.current?.focus()
      return
    }
    if (!clip.trim()) {
      toast('클립보드가 비어 있어요', 'warn')
      return
    }
    // mask synchronously so the user gets the protected text immediately
    const ents = detect(clip, detectOpts)
    const r = applyMask(clip, ents, new Set(), settings.mask, activeSession.mapping)
    const notice = settings.addNotice && settings.mask.mode === 'token' && r.mapping.length ? AI_NOTICE[settings.mask.tokenLang] : ''
    setText(clip)
    setDisabledKeys(new Set())
    if (await copyText(notice + r.text)) {
      commitMapping(r.mapping, clip)
      setCopied(true)
      toast(`${ents.length}건을 가려서 다시 클립보드에 넣었어요`, 'success')
    }
  }, [detectOpts, settings.mask, settings.addNotice, activeSession.mapping, commitMapping, toast])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        void doCopy()
      } else if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault()
        void quickClipboard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doCopy, quickClipboard])

  const addTerm = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    if (sessionTerms.some((x) => x.text === t)) return
    setSessionTerms((prev) => [...prev, { id: newId(), text: t, label: '가림' }])
    toast(`‘${t.length > 20 ? t.slice(0, 20) + '…' : t}’ 도 가릴게요`, 'success')
  }

  const saveTermsToDictionary = () => {
    if (!sessionTerms.length) return
    updateSettings((s) => ({
      ...s,
      detect: { ...s.detect, customTerms: [...s.detect.customTerms, ...sessionTerms.filter((t) => !s.detect.customTerms.some((c) => c.text === t.text))] },
    }))
    setSessionTerms([])
    toast('내 사전에 저장했어요. 앞으로 항상 가려집니다', 'success')
  }

  const onFile = async (file: File) => {
    if (!isPlainTextFile(file)) {
      toast('워드·엑셀·PDF 등은 ‘파일’ 탭에서 처리할 수 있어요', 'warn')
      return
    }
    const t = await decodeTextFile(file)
    setText(t.text)
    toast(`${file.name} 불러옴${t.encoding !== 'utf-8' ? ` (${t.encoding.toUpperCase()} 인코딩 자동 변환)` : ''}`)
  }

  // Build the preview including disabled entities (shown un-masked, clickable)
  const preview = useMemo(() => {
    const nodes: React.ReactNode[] = []
    let cursor = 0
    for (const e of entities) {
      if (e.start < cursor) continue
      if (e.start > cursor) nodes.push(deferred.slice(cursor, e.start))
      const key = keyOf(e)
      const group = TYPE_META[e.type].group
      const off = disabledIds.has(e.id)
      nodes.push(
        <button
          type="button"
          key={e.id}
          className={`chip g-${group} ${off ? 'chip-off' : ''} ${hoverKey === key ? 'chip-hover' : ''}`}
          title={off ? `가리지 않음 · 클릭하면 다시 가려요` : `원문: ${e.value}\n클릭하면 이 값은 가리지 않아요`}
          onClick={() => toggleKeys([key], off)}
        >
          {off ? e.value : replacementById.get(e.id)}
        </button>,
      )
      cursor = e.end
    }
    nodes.push(deferred.slice(cursor))
    return nodes
  }, [entities, deferred, disabledIds, replacementById, keyOf, hoverKey, toggleKeys])

  const isEmpty = !text.trim()

  return (
    <div className="view text-view">
      <div className="toolbar">
        <div className="toolbar-group">
          <Segmented<MaskMode>
            label="가리는 방식"
            value={settings.mask.mode}
            options={MODE_OPTIONS}
            onChange={(mode) => updateSettings((s) => ({ ...s, mask: { ...s.mask, mode } }))}
          />
          <p className="mode-desc">
            <Info size={14} /> {MODE_DESC[settings.mask.mode]}
          </p>
        </div>
        <div className="toolbar-group right">
          <Button variant="soft" icon={<Zap size={16} />} onClick={quickClipboard} title="클립보드의 글을 가려서 바로 다시 복사 (Ctrl+Shift+V)">
            클립보드 원클릭
          </Button>
        </div>
      </div>

      <div className={`workspace ${showPanel ? 'with-panel' : ''}`}>
        <Card className="pane pane-input">
          <CardHeader
            title="원문"
            subtitle="이 글은 브라우저 밖으로 나가지 않아요"
            icon={<EyeOff size={18} />}
            actions={
              <>
                <Button size="sm" variant="ghost" icon={<Sparkles size={15} />} onClick={() => setText(SAMPLE_TEXT)} title="예시 문장 넣기">
                  예시
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ClipboardPaste size={15} />}
                  onClick={async () => {
                    const c = await readText()
                    if (c != null) setText(c)
                    else {
                      toast('Ctrl+V로 붙여넣어 주세요', 'warn')
                      editorRef.current?.focus()
                    }
                  }}
                  title="클립보드에서 붙여넣기"
                >
                  붙여넣기
                </Button>
                <Button size="sm" variant="ghost" icon={<FileUp size={15} />} onClick={() => fileRef.current?.click()} title="텍스트 파일 열기">
                  <span className="hide-sm">파일</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Eraser size={15} />}
                  onClick={() => {
                    setText('')
                    setDisabledKeys(new Set())
                    setSessionTerms([])
                  }}
                  title="모두 지우기"
                  disabled={isEmpty}
                />
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept=".txt,.md,.csv,.tsv,.json,.log,.xml,.html,.htm,.yaml,.yml,.srt,.vtt,.eml,.ini,.env,.sql,.js,.ts,.py,.java,.kt,.go,.rb,.php,.cs,.c,.cpp,.h,text/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void onFile(f)
                    e.target.value = ''
                  }}
                />
              </>
            }
          />
          <div
            className="pane-body"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const f = e.dataTransfer.files?.[0]
              if (f) {
                e.preventDefault()
                void onFile(f)
              }
            }}
          >
            <HighlightEditor
              ref={editorRef}
              value={text}
              onChange={setText}
              entities={entities}
              isDisabled={isDisabled}
              onSelect={setSelection}
              ariaLabel="가릴 원문"
              placeholder={
                'AI에게 보내기 전 글을 여기에 붙여넣으세요.\n\n이름, 주민등록번호, 전화번호, 주소, 계좌번호, 카드번호, 이메일,\nAPI 키·비밀번호 등을 자동으로 찾아 가려 드립니다.\n\n처음이라면 위의 ‘예시’를 눌러 보세요.'
              }
            />
            {selection && selection.text.trim().length > 0 && (
              <div className="selection-pop">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Plus size={15} />}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    addTerm(selection.text)
                    setSelection(null)
                  }}
                >
                  선택한 ‘{selection.text.trim().slice(0, 12)}
                  {selection.text.trim().length > 12 ? '…' : ''}’ 가리기
                </Button>
              </div>
            )}
          </div>
          <footer className="pane-foot">
            <span className="muted">
              {text.length.toLocaleString()}자 · 드래그로 선택하면 원하는 부분도 가릴 수 있어요
            </span>
          </footer>
        </Card>

        <Card className="pane pane-output">
          <CardHeader
            title="가린 결과"
            subtitle={
              isEmpty ? '여기에 안전한 버전이 만들어져요' : maskedCount ? `${maskedCount}곳 · ${typeCount}종류를 가렸어요` : '가릴 항목을 찾지 못했어요'
            }
            icon={<Wand2 size={18} />}
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ListChecks size={15} />}
                  onClick={() => setShowPanel((v) => !v)}
                  className="panel-toggle"
                  aria-pressed={showPanel}
                >
                  <span className="hide-sm">항목</span>
                </Button>
              </>
            }
          />
          <div className="pane-body">
            <div
              className="preview"
              onCopy={() => {
                if (!isEmpty) commitMapping(result.mapping, text)
              }}
            >
              {isEmpty ? (
                <div className="preview-placeholder">
                  <div className="flow">
                    <span>원문 붙여넣기</span>
                    <span className="arrow">→</span>
                    <span>자동으로 가리기</span>
                    <span className="arrow">→</span>
                    <span>AI에 붙여넣기</span>
                    <span className="arrow">→</span>
                    <span>답변 되돌리기</span>
                  </div>
                </div>
              ) : (
                <>
                  {withNotice && <div className="notice-block">{AI_NOTICE[settings.mask.tokenLang].trim()}</div>}
                  {preview}
                </>
              )}
            </div>
          </div>
          <footer className="pane-foot output-foot">
            <div className="foot-left">
              {settings.mask.mode === 'token' && (
                <label className="inline-check" title="AI가 자리표시자를 그대로 쓰도록 안내 문장을 맨 앞에 붙입니다">
                  <input type="checkbox" checked={settings.addNotice} onChange={(e) => updateSettings({ addNotice: e.target.checked })} />
                  <MessageSquarePlus size={14} /> AI 안내문 포함
                </label>
              )}
              {settings.mask.mode !== 'redact' && (
                <span className="session-chip" title={`세션 생성: ${formatTime(activeSession.createdAt)}`}>
                  세션 기록 {activeSession.mapping.length}개
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      startNewSession()
                      toast('새 세션을 시작했어요. 번호가 1부터 다시 매겨집니다')
                    }}
                  >
                    <RotateCcw size={12} /> 새 세션
                  </button>
                </span>
              )}
            </div>
            <div className="foot-right">
              {copied && settings.mask.mode !== 'redact' && (
                <Button variant="soft" icon={<Undo2 size={16} />} onClick={goRestore} title="AI 답변을 받았다면 원래 값으로 되돌리세요">
                  답변 되돌리기
                </Button>
              )}
              <Button variant="primary" size="lg" icon={copied ? <Check size={17} /> : <Copy size={17} />} onClick={doCopy} disabled={isEmpty} title="Ctrl+Enter">
                {copied ? '복사됨' : '복사하기'}
              </Button>
            </div>
          </footer>
        </Card>

        {showPanel && (
          <Card className="pane pane-entities">
            <CardHeader title="찾은 개인정보" subtitle={entities.length ? `${new Set(entities.map(keyOf)).size}개 값 · 체크 해제하면 그대로 둬요` : undefined} />
            <div className="pane-body scroll">
              <EntityPanel entities={entities} disabledKeys={disabledKeys} replacements={replacementByKey} onToggle={toggleKeys} onHover={setHoverKey} />
            </div>
            <footer className="pane-foot add-word">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  addTerm(manualWord)
                  setManualWord('')
                }}
              >
                <input value={manualWord} onChange={(e) => setManualWord(e.target.value)} placeholder="회사명·프로젝트명 등 직접 추가" aria-label="직접 가릴 단어" />
                <Button variant="secondary" size="sm" icon={<Plus size={15} />} type="submit" disabled={!manualWord.trim()} title="추가" />
              </form>
              {sessionTerms.length > 0 && (
                <button type="button" className="link-btn" onClick={saveTermsToDictionary}>
                  직접 추가한 {sessionTerms.length}개를 내 사전에 영구 저장
                </button>
              )}
            </footer>
          </Card>
        )}
      </div>
    </div>
  )
}
