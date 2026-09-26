import { useState } from 'react'
import { BookMarked, Database, ListFilter, Palette, Plus, ScanSearch, ShieldOff, Trash2, Type } from 'lucide-react'
import { ALL_TYPES } from '../core/engine'
import { TYPE_META } from '../core/labels'
import type { EntityType, TokenLang } from '../core/types'
import { Button, Card, CardHeader, Segmented, Switch } from '../components/ui'
import { useApp, type Theme } from '../state/AppState'
import { RETENTION_LABEL, newId, type Retention } from '../lib/sessions'

export function SettingsView() {
  const { settings, updateSettings, wipeEverything, toast } = useApp()
  const [term, setTerm] = useState('')
  const [label, setLabel] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [allowDraft, setAllowDraft] = useState(settings.detect.allowList.join('\n'))

  const setEnabled = (t: EntityType, v: boolean) =>
    updateSettings((s) => ({ ...s, detect: { ...s.detect, enabled: { ...s.detect.enabled, [t]: v } } }))

  const addTerm = () => {
    const t = term.trim()
    if (!t) return
    if (isRegex) {
      try {
        new RegExp(t, 'u')
      } catch {
        toast('정규식 형식이 올바르지 않아요', 'warn')
        return
      }
    }
    updateSettings((s) => ({
      ...s,
      detect: { ...s.detect, customTerms: [...s.detect.customTerms, { id: newId(), text: t, label: label.trim() || '가림', regex: isRegex || undefined }] },
    }))
    setTerm('')
    setLabel('')
    setIsRegex(false)
  }

  return (
    <div className="view settings-view">
      <div className="settings-grid">
        <Card>
          <CardHeader title="찾을 항목" subtitle="끄면 해당 유형은 찾지도, 가리지도 않아요" icon={<ScanSearch size={18} />} />
          <div className="card-pad type-grid">
            {ALL_TYPES.filter((t) => t !== 'custom').map((t) => (
              <Switch
                key={t}
                checked={settings.detect.enabled[t]}
                onChange={(v) => setEnabled(t, v)}
                label={
                  <>
                    <span className={`dot g-${TYPE_META[t].group}`} /> {TYPE_META[t].name}
                  </>
                }
                description={TYPE_META[t].description}
              />
            ))}
          </div>
          <div className="card-pad top-line">
            <Switch
              checked={settings.detect.strongNames}
              onChange={(v) => updateSettings((s) => ({ ...s, detect: { ...s.detect, strongNames: v } }))}
              label="이름 추정 강화 모드"
              description="‘김민수가’, ‘이서연의’처럼 조사가 붙은 세 글자 이름도 추정해요. 일반 단어가 잘못 가려질 수 있어요."
            />
          </div>
        </Card>

        <div className="settings-col">
          <Card>
            <CardHeader title="내 사전" subtitle="자동으로 못 찾는 회사명·프로젝트명·내 이름을 등록하면 항상 가려요" icon={<BookMarked size={18} />} />
            <div className="card-pad">
              <form
                className="term-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  addTerm()
                }}
              >
                <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={isRegex ? '정규식 예: PRJ-\\d{4}' : '가릴 단어 예: 오로라 프로젝트'} aria-label="가릴 단어" />
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="표시 이름 예: 프로젝트" aria-label="표시 이름" className="short" />
                <Button type="submit" variant="primary" size="md" icon={<Plus size={16} />} disabled={!term.trim()}>
                  추가
                </Button>
              </form>
              <label className="inline-check small">
                <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} /> 정규식으로 입력 (고급)
              </label>
              {settings.detect.customTerms.length > 0 ? (
                <ul className="term-list">
                  {settings.detect.customTerms.map((t) => (
                    <li key={t.id}>
                      <span className="mono">{t.text}</span>
                      {t.regex && <span className="tag">정규식</span>}
                      <span className="arrow">→</span>
                      <span className="tag g-custom">[{t.label}_1]</span>
                      <button
                        type="button"
                        className="icon-btn danger"
                        aria-label="삭제"
                        onClick={() => updateSettings((s) => ({ ...s, detect: { ...s.detect, customTerms: s.detect.customTerms.filter((x) => x.id !== t.id) } }))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">등록한 단어가 없어요.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="가리지 않을 값" subtitle="회사 대표번호·공용 이메일처럼 드러나도 되는 값을 한 줄에 하나씩" icon={<ShieldOff size={18} />} />
            <div className="card-pad">
              <textarea
                className="plain-textarea small"
                value={allowDraft}
                onChange={(e) => setAllowDraft(e.target.value)}
                onBlur={() =>
                  updateSettings((s) => ({
                    ...s,
                    detect: {
                      ...s.detect,
                      allowList: allowDraft
                        .split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean),
                    },
                  }))
                }
                placeholder={'1588-0000\nhelp@mycompany.com'}
                aria-label="가리지 않을 값"
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="표시 방식" icon={<Type size={18} />} />
            <div className="card-pad stack">
              <div className="field">
                <span className="field-label">자리표시자 언어</span>
                <Segmented<TokenLang>
                  label="자리표시자 언어"
                  size="sm"
                  value={settings.mask.tokenLang}
                  onChange={(v) => updateSettings((s) => ({ ...s, mask: { ...s.mask, tokenLang: v } }))}
                  options={[
                    { value: 'ko', label: '한국어 [이름_1]' },
                    { value: 'en', label: 'English [NAME_1]' },
                  ]}
                />
              </div>
              <div className="field">
                <span className="field-label">영구 가림 방식</span>
                <Segmented<'partial' | 'full'>
                  label="영구 가림 방식"
                  size="sm"
                  value={settings.mask.partialRedact ? 'partial' : 'full'}
                  onChange={(v) => updateSettings((s) => ({ ...s, mask: { ...s.mask, partialRedact: v === 'partial' } }))}
                  options={[
                    { value: 'partial', label: '일부만 010-****-5678' },
                    { value: 'full', label: '전부 ■■■■' },
                  ]}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="화면" icon={<Palette size={18} />} />
            <div className="card-pad">
              <Segmented<Theme>
                label="테마"
                size="sm"
                value={settings.theme}
                onChange={(v) => updateSettings({ theme: v })}
                options={[
                  { value: 'system', label: '시스템' },
                  { value: 'light', label: '라이트' },
                  { value: 'dark', label: '다크' },
                ]}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="복원 키 보관" subtitle="원래 값과 자리표시자의 연결은 이 브라우저에만 저장돼요" icon={<Database size={18} />} />
            <div className="card-pad stack">
              <select
                className="select"
                value={settings.retention}
                onChange={(e) => updateSettings({ retention: e.target.value as Retention })}
                aria-label="보관 기간"
              >
                {(Object.keys(RETENTION_LABEL) as Retention[]).map((r) => (
                  <option key={r} value={r}>
                    {RETENTION_LABEL[r]}
                  </option>
                ))}
              </select>
              <Button
                variant="danger"
                icon={<Trash2 size={16} />}
                onClick={() => {
                  if (confirm('설정, 내 사전, 모든 복원 키를 지울까요? 되돌릴 수 없어요.')) {
                    wipeEverything()
                    setAllowDraft('')
                    toast('이 기기에 저장된 가림 데이터를 모두 지웠어요', 'success')
                  }
                }}
              >
                이 기기의 모든 데이터 지우기
              </Button>
            </div>
          </Card>

          <p className="hint center">
            <ListFilter size={14} /> 설정은 이 브라우저에만 저장되며 어디에도 전송되지 않아요.
          </p>
        </div>
      </div>
    </div>
  )
}
