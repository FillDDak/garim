import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderUp,
  Loader2,
  Presentation,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react'
import JSZip from 'jszip'
import { detect } from '../core/engine'
import { TYPE_META } from '../core/labels'
import { applyMask } from '../core/mask'
import type { EntityType, MappingEntry, MaskResult } from '../core/types'
import { Button, Card, CardHeader, Segmented } from '../components/ui'
import { useApp } from '../state/AppState'
import { downloadBlob } from '../lib/clipboard'
import { newId } from '../lib/sessions'
import { makeSampleDocx } from '../lib/sampleDocx'
import { decodeTextFile, isPlainTextFile } from '../lib/files/text'
import { officeKind, processOffice } from '../lib/files/office'
import { processPdf, redactPdf, type PdfResult } from '../lib/files/pdf'
import type { MaskMode } from '../core/types'

type Kind = 'text' | 'docx' | 'pptx' | 'xlsx' | 'hwpx' | 'pdf' | 'unsupported'

interface Job {
  id: string
  file: File
  kind: Kind
  status: 'working' | 'done' | 'error'
  progress?: number
  error?: string
  masked?: MaskResult
  outputs: Array<{ label: string; blob: Blob; name: string; primary?: boolean }>
  notes: string[]
  pdf?: PdfResult
  /** Regions found by OCR on scanned pages (not part of the text mapping). */
  ocrFound?: number
  sourceText?: string
}

function kindOf(file: File): Kind {
  const o = officeKind(file.name)
  if (o) return o
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf'
  if (isPlainTextFile(file)) return 'text'
  return 'unsupported'
}

const KIND_ICON: Record<Kind, React.ReactNode> = {
  text: <Type size={20} />,
  docx: <FileText size={20} />,
  hwpx: <FileText size={20} />,
  pptx: <Presentation size={20} />,
  xlsx: <FileSpreadsheet size={20} />,
  pdf: <FileType2 size={20} />,
  unsupported: <AlertTriangle size={20} />,
}

const KIND_LABEL: Record<Kind, string> = {
  text: '텍스트',
  docx: 'Word',
  hwpx: '한글(HWPX)',
  pptx: 'PowerPoint',
  xlsx: 'Excel',
  pdf: 'PDF',
  unsupported: '미지원',
}

const fmtSize = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)
const stem = (name: string) => name.replace(/\.[^.]+$/, '')
const ext = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()

export function FileView({ openInText }: { openInText: (text: string) => void }) {
  const { settings, updateSettings, activeSession, commitMapping, toast } = useApp()
  const [jobs, setJobs] = useState<Job[]>([])
  const [dropping, setDropping] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // keep a running mapping so numbering stays consistent across files processed together
  const runningMapping = useRef<MappingEntry[]>([])

  const patch = useCallback((id: string, p: Partial<Job>) => setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j))), [])

  const processOne = useCallback(
    async (job: Job) => {
      const prior = [...activeSession.mapping, ...runningMapping.current]
      const maskOpts = settings.mask
      try {
        if (job.kind === 'text') {
          const dec = await decodeTextFile(job.file)
          const ents = detect(dec.text, settings.detect)
          const r = applyMask(dec.text, ents, new Set(), maskOpts, prior)
          const isCsv = /\.(csv|tsv)$/i.test(job.file.name)
          const blob = new Blob([isCsv || dec.bom ? '﻿' : '', r.text], { type: 'text/plain;charset=utf-8' })
          const notes = dec.encoding !== 'utf-8' ? [`${dec.encoding.toUpperCase()} 인코딩을 자동으로 인식해 UTF-8로 저장했어요`] : []
          runningMapping.current.push(...r.mapping)
          patch(job.id, { status: 'done', masked: r, sourceText: dec.text, outputs: [{ label: '가린 파일', blob, name: `${stem(job.file.name)}_가림${ext(job.file.name)}`, primary: true }], notes })
        } else if (job.kind === 'pdf') {
          const res = await processPdf(await job.file.arrayBuffer(), settings.detect, maskOpts, prior, (p) => patch(job.id, { progress: p * 0.3 }))
          runningMapping.current.push(...res.masked.mapping)
          const notes: string[] = []
          const red = await redactPdf(
            res,
            new Set(),
            settings.imageStyle === 'white' ? 'white' : 'black',
            (p) => patch(job.id, { progress: 0.3 + p * 0.7 }),
            res.emptyPages ? { detect: settings.detect } : undefined,
          )
          const pdfBlob = red.blob
          if (red.ocrPages) notes.push(`스캔된 ${red.ocrPages}쪽은 글자 인식(OCR)으로 ${red.ocrFound}곳을 찾아 가렸어요. 스캔 품질에 따라 놓칠 수 있으니 꼭 확인해 주세요`)
          notes.push('가린 PDF는 페이지를 이미지로 바꿔 만들어서, 가린 글자를 복사·복원할 수 없어요')
          patch(job.id, {
            status: 'done',
            masked: res.masked,
            pdf: res,
            ocrFound: red.ocrFound,
            sourceText: res.text,
            notes,
            outputs: [
              { label: '가린 PDF', blob: pdfBlob, name: `${stem(job.file.name)}_가림.pdf`, primary: true },
              { label: '가린 텍스트', blob: new Blob([res.masked.text], { type: 'text/plain;charset=utf-8' }), name: `${stem(job.file.name)}_가림.txt` },
            ],
          })
        } else if (job.kind === 'docx' || job.kind === 'pptx' || job.kind === 'xlsx' || job.kind === 'hwpx') {
          const res = await processOffice(await job.file.arrayBuffer(), job.kind, settings.detect, maskOpts, prior)
          runningMapping.current.push(...res.masked.mapping)
          patch(job.id, {
            status: 'done',
            masked: res.masked,
            sourceText: res.text,
            notes: res.notes,
            outputs: [
              { label: `가린 ${KIND_LABEL[job.kind]} 파일`, blob: res.blob, name: `${stem(job.file.name)}_가림${ext(job.file.name)}`, primary: true },
              { label: '가린 텍스트', blob: new Blob([res.masked.text], { type: 'text/plain;charset=utf-8' }), name: `${stem(job.file.name)}_가림.txt` },
            ],
          })
        } else {
          patch(job.id, {
            status: 'error',
            error: /\.hwp$/i.test(job.file.name)
              ? 'HWP(구 형식)는 지원하지 않아요. 한글에서 ‘다른 이름으로 저장 → HWPX’ 후 넣어 주세요'
              : /\.(doc|xls|ppt)$/i.test(job.file.name)
                ? '구형 오피스 파일이에요. docx·xlsx·pptx로 저장한 뒤 넣어 주세요'
                : '지원하지 않는 형식이에요',
          })
        }
      } catch (err) {
        console.error(err)
        patch(job.id, { status: 'error', error: '파일을 읽는 중 문제가 생겼어요. 암호가 걸려 있거나 손상된 파일일 수 있어요' })
      }
    },
    [activeSession.mapping, settings.detect, settings.mask, settings.imageStyle, patch],
  )

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (!list.length) return
      const images = list.filter((f) => f.type.startsWith('image/'))
      if (images.length) toast('이미지는 ‘이미지’ 탭에서 가릴 수 있어요', 'warn')
      const created: Job[] = list
        .filter((f) => !f.type.startsWith('image/'))
        .map((file) => ({ id: newId(), file, kind: kindOf(file), status: 'working', outputs: [], notes: [] }))
      setJobs((prev) => [...created, ...prev])
      for (const j of created) await processOne(j)
    },
    [processOne, toast],
  )

  const downloadOutput = (job: Job, i: number) => {
    const o = job.outputs[i]
    downloadBlob(o.blob, o.name)
    if (job.masked) commitMapping(job.masked.mapping, job.file.name)
  }

  const downloadAll = async () => {
    const done = jobs.filter((j) => j.status === 'done' && j.outputs.length)
    if (!done.length) return
    if (done.length === 1) return downloadOutput(done[0], 0)
    const zip = new JSZip()
    const used = new Set<string>()
    for (const j of done) {
      const o = j.outputs[0]
      let n = o.name
      let k = 2
      while (used.has(n)) n = `${stem(o.name)}_${k++}${ext(o.name)}`
      used.add(n)
      zip.file(n, o.blob)
      if (j.masked) commitMapping(j.masked.mapping, j.file.name)
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), `가림_파일_${done.length}개.zip`)
  }

  const counts = (m?: MaskResult) =>
    m
      ? (Object.entries(m.counts) as Array<[EntityType, number]>)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => (
            <span key={t} className={`tag g-${TYPE_META[t].group}`}>
              {TYPE_META[t].name} {n}
            </span>
          ))
      : null

  return (
    <div
      className={`view file-view ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".docx,.xlsx,.pptx,.hwpx,.pdf,.txt,.md,.csv,.tsv,.json,.log,.xml,.html,.yaml,.yml,.srt,.vtt,.eml,.sql"
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <div className="file-top">
        <Card className="drop-card compact">
          <button type="button" className="dropzone" onClick={() => inputRef.current?.click()}>
            <FolderUp size={34} strokeWidth={1.5} />
            <strong>문서를 끌어다 놓으면 서식은 그대로, 개인정보만 가린 파일을 만들어 드려요</strong>
            <span className="formats">
              <em>Word</em> <em>Excel</em> <em>PowerPoint</em> <em>한글 HWPX</em> <em>PDF</em> <em>CSV</em> <em>TXT·JSON·로그</em>
            </span>
            <span className="dz-meta">파일은 업로드되지 않아요 · 여러 개를 한 번에 · 문서 작성자 정보도 함께 지움</span>
          </button>
          <div className="drop-extra">
            <button type="button" className="link-btn" onClick={async () => addFiles([await makeSampleDocx()])}>
              <Sparkles size={14} /> 예시 Word 문서로 체험해 보기
            </button>
          </div>
        </Card>
        <Card className="file-options">
          <CardHeader title="바꾸는 방식" />
          <div className="card-pad">
            <Segmented<MaskMode>
              label="바꾸는 방식"
              size="sm"
              value={settings.mask.mode}
              onChange={(mode) => updateSettings((s) => ({ ...s, mask: { ...s.mask, mode } }))}
              options={[
                { value: 'token', label: '자리표시자' },
                { value: 'fake', label: '가짜 값' },
                { value: 'redact', label: '영구 가림' },
              ]}
            />
            <p className="hint">
              {settings.mask.mode === 'redact'
                ? '공유용: 김*수, 010-****-5678처럼 가려요.'
                : 'AI에 올릴 문서라면 이 방식을 추천해요. AI 답변은 ‘되돌리기’에서 복원돼요.'}
            </p>
            <p className="hint">PDF는 방식과 관계없이 가린 부분을 박스로 덮은 이미지 PDF로 만들어요.</p>
          </div>
        </Card>
      </div>

      {jobs.length > 0 && (
        <div className="jobs-head">
          <h3>
            처리한 파일 <span className="muted">{jobs.length}</span>
          </h3>
          <div className="row gap">
            <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={() => setJobs([])}>
              목록 비우기
            </Button>
            {jobs.filter((j) => j.status === 'done').length > 1 && (
              <Button size="sm" variant="primary" icon={<Download size={15} />} onClick={downloadAll}>
                모두 받기 (ZIP)
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="jobs">
        {jobs.map((job) => {
          const total = (job.masked ? Object.values(job.masked.counts).reduce((a, b) => a + (b ?? 0), 0) : 0) + (job.ocrFound ?? 0)
          const isOpen = expanded === job.id
          return (
            <Card key={job.id} className={`job job-${job.status}`}>
              <div className="job-main">
                <div className={`job-icon kind-${job.kind}`}>{KIND_ICON[job.kind]}</div>
                <div className="job-info">
                  <div className="job-name" title={job.file.name}>
                    {job.file.name}
                  </div>
                  <div className="job-meta">
                    <span>{KIND_LABEL[job.kind]}</span>
                    <span>{fmtSize(job.file.size)}</span>
                    {job.status === 'working' && (
                      <span className="working">
                        <Loader2 size={13} className="spin" /> 처리 중{job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '…'}
                      </span>
                    )}
                    {job.status === 'done' && (
                      <span className={total ? 'ok' : 'muted'}>
                        <CheckCircle2 size={13} /> {total ? `${total}곳 가림` : '가릴 항목 없음'}
                      </span>
                    )}
                    {job.status === 'error' && (
                      <span className="err">
                        <AlertTriangle size={13} /> {job.error}
                      </span>
                    )}
                  </div>
                  {job.masked && total > 0 && <div className="tags">{counts(job.masked)}</div>}
                </div>
                <div className="job-actions">
                  {job.outputs.map((o, i) => (
                    <Button key={o.name} size="sm" variant={o.primary ? 'primary' : 'secondary'} icon={<Download size={15} />} onClick={() => downloadOutput(job, i)}>
                      {o.label}
                    </Button>
                  ))}
                  {job.masked && (
                    <Button size="sm" variant="ghost" icon={<ChevronDown size={15} className={isOpen ? 'rot180' : ''} />} onClick={() => setExpanded(isOpen ? null : job.id)} aria-expanded={isOpen}>
                      미리보기
                    </Button>
                  )}
                </div>
              </div>
              {job.notes.length > 0 && (
                <ul className="job-notes">
                  {job.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {isOpen && job.masked && (
                <div className="job-preview">
                  <pre>{job.masked.text.slice(0, 6000)}{job.masked.text.length > 6000 ? '\n…' : ''}</pre>
                  {job.sourceText && (
                    <button type="button" className="link-btn" onClick={() => openInText(job.sourceText!)}>
                      원문을 ‘텍스트’ 탭에서 열어 항목별로 조정하기 →
                    </button>
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>
      {dropping && <div className="drop-overlay">여기에 놓으세요</div>}
    </div>
  )
}
