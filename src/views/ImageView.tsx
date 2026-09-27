import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  Download,
  ImagePlus,
  Loader2,
  MousePointerSquareDashed,
  QrCode,
  RotateCcw,
  ScanText,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import { TYPE_META } from '../core/labels'
import { Button, Card, CardHeader, Empty, Segmented } from '../components/ui'
import { useApp } from '../state/AppState'
import { barcodeSupported, detectCodes, detectInImage, type Detection, type OcrBox, type OcrProgress } from '../lib/ocr'
import { canvasToBlob, loadImageToCanvas, paintRedaction, type RedactStyle } from '../lib/redact'
import { downloadBlob } from '../lib/clipboard'
import { newId } from '../lib/sessions'
import { makeSampleImage } from '../lib/sampleImage'

interface ImageItem {
  id: string
  name: string
  source: HTMLCanvasElement
  thumb: string
  boxes: Detection[]
  disabled: Set<string>
  status: 'idle' | 'scanning' | 'done' | 'error'
  scannedText?: string
}

const STYLE_OPTIONS: Array<{ value: RedactStyle; label: string; hint: string }> = [
  { value: 'black', label: '검은 박스', hint: '가장 안전해요' },
  { value: 'white', label: '흰 박스', hint: '문서 배경과 어울려요' },
  { value: 'pixelate', label: '모자이크', hint: '노이즈를 섞어 복원을 어렵게 해요' },
  { value: 'blur', label: '흐림', hint: '부드럽게 가려요' },
]

const groupOf = (d: Detection) => (d.type === 'qr' ? 'tech' : d.type === 'face' ? 'person' : TYPE_META[d.type].group)
const typeName = (d: Detection) => (d.type === 'qr' ? 'QR·바코드' : d.type === 'face' ? '얼굴' : d.type === 'custom' ? d.label ?? '직접 지정' : TYPE_META[d.type].name)

type EditMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'
const HANDLES: EditMode[] = ['nw', 'ne', 'sw', 'se']

/** Applies a pointer delta (image pixels) to a box for a move or a corner resize. */
function editBox(orig: OcrBox, mode: EditMode, dx: number, dy: number, W: number, H: number): OcrBox {
  if (mode === 'move') {
    const nx = Math.max(0, Math.min(W - orig.w, orig.x + dx))
    const ny = Math.max(0, Math.min(H - orig.h, orig.y + dy))
    const ox = nx - orig.x
    const oy = ny - orig.y
    return { ...orig, x: nx, y: ny, quad: orig.quad?.map(([x, y]) => [x + ox, y + oy] as [number, number]) }
  }
  const min = Math.max(4, W / 400)
  let x0 = orig.x
  let y0 = orig.y
  let x1 = orig.x + orig.w
  let y1 = orig.y + orig.h
  if (mode === 'nw' || mode === 'sw') x0 = Math.max(0, Math.min(x1 - min, x0 + dx))
  else x1 = Math.min(W, Math.max(x0 + min, x1 + dx))
  if (mode === 'nw' || mode === 'ne') y0 = Math.max(0, Math.min(y1 - min, y0 + dy))
  else y1 = Math.min(H, Math.max(y0 + min, y1 + dy))
  return { ...orig, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '') || 'image'
}

export function ImageView() {
  const { settings, updateSettings, toast } = useApp()
  const [items, setItems] = useState<ImageItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [progress, setProgress] = useState<OcrProgress | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const editRef = useRef<{ id: string; mode: EditMode; px: number; py: number; orig: OcrBox; moved: boolean } | null>(null)
  const [dropping, setDropping] = useState(false)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const style = settings.imageStyle as RedactStyle

  const active = items.find((i) => i.id === activeId) ?? null

  const update = useCallback((id: string, fn: (it: ImageItem) => ImageItem) => {
    setItems((prev) => prev.map((it) => (it.id === id ? fn(it) : it)))
  }, [])

  const scan = useCallback(
    async (item: ImageItem) => {
      update(item.id, (it) => ({ ...it, status: 'scanning' }))
      try {
        const [ocr, codes, faces] = await Promise.all([
          detectInImage(item.source, settings.detect, (p) => setProgress(p)),
          detectCodes(item.source),
          import('../lib/faces').then((m) => m.detectFaces(item.source)),
        ])
        const boxes = [...faces, ...ocr.detections, ...codes]
        update(item.id, (it) => ({
          ...it,
          status: 'done',
          scannedText: ocr.text,
          boxes: [...it.boxes.filter((b) => b.id.startsWith('manual:')), ...boxes],
        }))
        toast(boxes.length ? `${boxes.length}곳을 찾아 가렸어요. 빠진 곳은 드래그로 추가하세요` : '글자 속 개인정보를 찾지 못했어요. 필요한 곳을 드래그해 가리세요', boxes.length ? 'success' : 'default')
      } catch (err) {
        console.error(err)
        update(item.id, (it) => ({ ...it, status: 'error' }))
        toast('글자 인식에 실패했어요. 직접 드래그해서 가릴 수 있어요', 'warn')
      } finally {
        setProgress(null)
      }
    },
    [settings.detect, toast, update],
  )

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i.test(f.name))
      if (!list.length) {
        toast('이미지 파일(PNG, JPG, WEBP 등)을 넣어 주세요', 'warn')
        return
      }
      const created: ImageItem[] = []
      for (const f of list) {
        try {
          const source = await loadImageToCanvas(f)
          const t = document.createElement('canvas')
          const s = 120 / Math.max(source.width, source.height)
          t.width = Math.max(1, Math.round(source.width * s))
          t.height = Math.max(1, Math.round(source.height * s))
          t.getContext('2d')!.drawImage(source, 0, 0, t.width, t.height)
          created.push({
            id: newId(),
            name: f.name || `capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`,
            source,
            thumb: t.toDataURL('image/jpeg', 0.7),
            boxes: [],
            disabled: new Set(),
            status: 'idle',
          })
        } catch {
          toast(`${f.name}: 이 이미지 형식은 브라우저에서 열 수 없어요`, 'warn')
        }
      }
      if (!created.length) return
      setItems((prev) => [...prev, ...created])
      setActiveId(created[0].id)
      // auto-scan sequentially
      for (const it of created) await scan(it)
    },
    [scan, toast],
  )

  // paste from clipboard anywhere on this view
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length) {
        e.preventDefault()
        void addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  // render preview
  const render = useCallback(
    (item: ImageItem, target: HTMLCanvasElement) => {
      target.width = item.source.width
      target.height = item.source.height
      const ctx = target.getContext('2d')!
      ctx.drawImage(item.source, 0, 0)
      for (const b of item.boxes) if (!item.disabled.has(b.id)) paintRedaction(ctx, b.box, style)
    },
    [style],
  )

  useEffect(() => {
    if (active && previewRef.current) render(active, previewRef.current)
  }, [active, render])

  const toImageCoords = (clientX: number, clientY: number) => {
    const el = stageRef.current
    if (!el || !active) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(active.source.width, ((clientX - r.left) / r.width) * active.source.width)),
      y: Math.max(0, Math.min(active.source.height, ((clientY - r.top) / r.height) * active.source.height)),
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.img-box-x')) return
    const boxEl = target.closest<HTMLElement>('.img-box[data-id]')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = toImageCoords(e.clientX, e.clientY)
    if (boxEl) {
      const b = active.boxes.find((x) => x.id === boxEl.dataset.id)
      if (!b) return
      const handle = target.closest<HTMLElement>('.img-box-h')?.dataset.h as EditMode | undefined
      editRef.current = { id: b.id, mode: handle ?? 'move', px: p.x, py: p.y, orig: b.box, moved: false }
      setSelected(b.id)
      return
    }
    setSelected(null)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const ed = editRef.current
    if (ed && active) {
      const p = toImageCoords(e.clientX, e.clientY)
      const dx = p.x - ed.px
      const dy = p.y - ed.py
      // a few screen pixels of jitter still count as a click
      const r = stageRef.current?.getBoundingClientRect()
      const slop = r ? (4 * active.source.width) / r.width : 4
      if (!ed.moved && Math.hypot(dx, dy) < slop) return
      ed.moved = true
      const box = editBox(ed.orig, ed.mode, dx, dy, active.source.width, active.source.height)
      update(active.id, (it) => ({ ...it, boxes: it.boxes.map((b) => (b.id === ed.id ? { ...b, box } : b)) }))
      return
    }
    if (!drag) return
    const p = toImageCoords(e.clientX, e.clientY)
    setDrag({ ...drag, x1: p.x, y1: p.y })
  }
  const onPointerUp = () => {
    const ed = editRef.current
    if (ed) {
      editRef.current = null
      if (!ed.moved && ed.mode === 'move') toggleBox(ed.id)
      return
    }
    if (!drag || !active) return
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    setDrag(null)
    const minSide = Math.max(4, active.source.width / 300)
    if (w < minSide || h < minSide) return
    const id = `manual:${newId()}`
    update(active.id, (it) => ({
      ...it,
      boxes: [...it.boxes, { id, type: 'custom', label: '직접 지정', text: '직접 그린 영역', box: { x, y, w, h } }],
    }))
    setSelected(id)
  }
  const onPointerCancel = () => {
    const ed = editRef.current
    if (ed && active) update(active.id, (it) => ({ ...it, boxes: it.boxes.map((b) => (b.id === ed.id ? { ...b, box: ed.orig } : b)) }))
    editRef.current = null
    setDrag(null)
  }

  const toggleBox = (id: string) => {
    if (!active) return
    update(active.id, (it) => {
      const d = new Set(it.disabled)
      if (d.has(id)) d.delete(id)
      else d.add(id)
      return { ...it, disabled: d }
    })
  }
  const removeBox = (id: string) => {
    if (!active) return
    update(active.id, (it) => ({ ...it, boxes: it.boxes.filter((b) => b.id !== id) }))
    if (selected === id) setSelected(null)
  }

  // keyboard: Delete removes the selected box, arrows nudge it (Shift = 10px), Esc deselects
  useEffect(() => {
    if (!selected || !active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const b = active.boxes.find((x) => x.id === selected)
      if (!b) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeBox(b.id)
      } else if (e.key === 'Escape') {
        setSelected(null)
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        const step = (e.shiftKey ? 10 : 1) * Math.max(1, active.source.width / 1000)
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        // Alt + arrows resize from the bottom-right corner instead of moving
        const box = editBox(b.box, e.altKey ? 'se' : 'move', dx, dy, active.source.width, active.source.height)
        update(active.id, (it) => ({ ...it, boxes: it.boxes.map((x) => (x.id === b.id ? { ...x, box } : x)) }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const exportBlob = async (item: ImageItem) => {
    const c = document.createElement('canvas')
    render(item, c)
    const blob = await canvasToBlob(c, 'image/png')
    c.width = c.height = 0
    return blob
  }

  const download = async () => {
    if (!active) return
    downloadBlob(await exportBlob(active), `${baseName(active.name)}_가림.png`)
    toast('저장했어요 · 사진 속 위치정보(EXIF)도 함께 지워졌어요', 'success')
  }

  const downloadAll = async () => {
    if (items.length === 1) return download()
    const zip = new JSZip()
    const used = new Set<string>()
    for (const it of items) {
      let n = `${baseName(it.name)}_가림.png`
      let k = 2
      while (used.has(n)) n = `${baseName(it.name)}_가림_${k++}.png`
      used.add(n)
      zip.file(n, await exportBlob(it))
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), `가림_이미지_${items.length}개.zip`)
  }

  const copyImage = async () => {
    if (!active) return
    try {
      const blob = await exportBlob(active)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast('가린 이미지를 복사했어요. 채팅창에 바로 붙여넣으세요', 'success')
    } catch {
      toast('이 브라우저는 이미지 복사를 지원하지 않아요. 저장하기를 이용해 주세요', 'warn')
    }
  }

  const boxesSorted = useMemo(() => (active ? [...active.boxes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x) : []), [active])
  const scanning = active?.status === 'scanning'

  return (
    <div
      className={`view image-view ${dropping ? 'dropping' : ''}`}
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
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {!items.length ? (
        <Card className="drop-card">
          <button type="button" className="dropzone" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={40} strokeWidth={1.5} />
            <strong>캡처·사진을 끌어다 놓거나, Ctrl+V로 붙여넣으세요</strong>
            <span>카톡 대화, 주문내역, 신분증·학생증, 자동차등록증, 계약서 사진 속 이름·주민번호·주소·카드·계좌번호와 얼굴을 찾아 가립니다.</span>
            <span className="dz-meta">
              PNG · JPG · WEBP · 여러 장 가능 · 기울어지거나 비스듬히 찍은 사진은 자동으로 펴서 인식 · 처음 한 번 글자·얼굴 인식 모델(약 11MB)을 받은 뒤에는 오프라인에서도 동작
            </span>
            <span className="dz-meta">사진은 문서를 정면에서, 화면에 꽉 차게 찍을수록 정확해요</span>
            <span className="btn btn-primary btn-md">이미지 선택</span>
          </button>
          <div className="drop-extra">
            <button type="button" className="link-btn" onClick={async () => addFiles([await makeSampleImage()])}>
              <Sparkles size={14} /> 예시 캡처로 체험해 보기
            </button>
          </div>
        </Card>
      ) : (
        <div className="image-layout">
          <Card className="image-stage-card">
            <CardHeader
              title={active?.name ?? '이미지'}
              subtitle={
                scanning
                  ? progress
                    ? `${progress.status} ${Math.round(progress.progress * 100)}%`
                    : '글자 인식 준비 중…'
                  : '빈 곳을 드래그해 추가 · 박스를 끌어 이동, 모서리로 크기 조절 · 누르면 켜고 끄기'
              }
              icon={scanning ? <Loader2 size={18} className="spin" /> : <MousePointerSquareDashed size={18} />}
              actions={
                <>
                  <Button size="sm" variant="ghost" icon={<ScanText size={15} />} onClick={() => active && scan(active)} disabled={!active || scanning}>
                    <span className="hide-sm">다시 인식</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RotateCcw size={15} />}
                    onClick={() => active && update(active.id, (it) => ({ ...it, boxes: it.boxes.filter((b) => !b.id.startsWith('manual:')), disabled: new Set() }))}
                    disabled={!active}
                    title="직접 그린 박스 지우기"
                  />
                </>
              }
            />
            <div className="stage-wrap">
              {active && (
                <div
                  className="stage"
                  ref={stageRef}
                  style={{ aspectRatio: `${active.source.width} / ${active.source.height}`, width: `min(100%, calc(var(--stage-h) * ${(active.source.width / active.source.height).toFixed(4)}))` }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                >
                  <canvas ref={previewRef} className="stage-canvas" />
                  {scanning && <div className="scanline" />}
                  {active.boxes.map((b) => {
                    const off = active.disabled.has(b.id)
                    const W = active.source.width
                    const H = active.source.height
                    // perspective / rotated text: exact polygon relative to its bounding box
                    const poly = b.box.quad?.map(([x, y]) => [((x - b.box.x) / b.box.w) * 100, ((y - b.box.y) / b.box.h) * 100] as const)
                    return (
                      <div
                        key={b.id}
                        data-id={b.id}
                        className={`img-box g-${groupOf(b)} ${poly ? 'quad' : ''} ${off ? 'off' : ''} ${hover === b.id ? 'hover' : ''} ${selected === b.id ? 'sel' : ''}`}
                        style={{
                          left: `${(b.box.x / W) * 100}%`,
                          top: `${(b.box.y / H) * 100}%`,
                          width: `${(b.box.w / W) * 100}%`,
                          height: `${(b.box.h / H) * 100}%`,
                          transform: b.box.angle && !poly ? `rotate(${b.box.angle}rad)` : undefined,
                          clipPath: poly ? `polygon(${poly.map(([x, y]) => `${x}% ${y}%`).join(', ')})` : undefined,
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleBox(b.id)
                          }
                        }}
                        onFocus={() => setSelected(b.id)}
                        tabIndex={0}
                        onMouseEnter={() => setHover(b.id)}
                        onMouseLeave={() => setHover(null)}
                        title={`${typeName(b)}: ${b.text}${off ? ' (가리지 않음)' : ''} · 누르면 켜고 끄기, 끌어서 이동${poly ? '' : ', 모서리로 크기 조절'}`}
                        role="button"
                        aria-pressed={!off}
                      >
                        {poly && (
                          <svg className="img-box-poly" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                            <polygon points={poly.map(([x, y]) => `${x},${y}`).join(' ')} />
                          </svg>
                        )}
                        {!poly &&
                          HANDLES.map((h) => <span key={h} className={`img-box-h ${h}`} data-h={h} aria-hidden="true" />)}
                        {!poly && (
                          <button
                            type="button"
                            className="img-box-x"
                            aria-label="박스 삭제"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeBox(b.id)
                            }}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {drag && (
                    <div
                      className="img-box drawing"
                      style={{
                        left: `${(Math.min(drag.x0, drag.x1) / active.source.width) * 100}%`,
                        top: `${(Math.min(drag.y0, drag.y1) / active.source.height) * 100}%`,
                        width: `${(Math.abs(drag.x1 - drag.x0) / active.source.width) * 100}%`,
                        height: `${(Math.abs(drag.y1 - drag.y0) / active.source.height) * 100}%`,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
            {items.length > 1 && (
              <div className="thumbs">
                {items.map((it) => (
                  <div key={it.id} className={`thumb ${it.id === activeId ? 'active' : ''}`}>
                    <button type="button" onClick={() => setActiveId(it.id)} title={it.name}>
                      <img src={it.thumb} alt={it.name} />
                      {it.status === 'scanning' && <Loader2 size={16} className="spin thumb-spin" />}
                      {it.status === 'done' && <span className="thumb-badge">{it.boxes.length - it.disabled.size}</span>}
                    </button>
                    <button
                      type="button"
                      className="thumb-x"
                      aria-label={`${it.name} 제거`}
                      onClick={() => {
                        setItems((prev) => prev.filter((x) => x.id !== it.id))
                        if (activeId === it.id) setActiveId(items.find((x) => x.id !== it.id)?.id ?? null)
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="image-side">
            <Card>
              <CardHeader title="가리는 모양" />
              <div className="card-pad">
                <Segmented<RedactStyle> label="가리는 모양" value={style} options={STYLE_OPTIONS} onChange={(v) => updateSettings({ imageStyle: v })} size="sm" />
                {(style === 'pixelate' || style === 'blur') && (
                  <p className="hint warn">
                    <ShieldAlert size={14} /> 모자이크·흐림은 글자 크기가 크면 추측될 수 있어요. 주민번호·계좌번호는 박스를 권장해요.
                  </p>
                )}
              </div>
            </Card>

            <Card className="grow">
              <CardHeader title="가린 영역" subtitle={active ? `${active.boxes.length - active.disabled.size}/${active.boxes.length}곳 적용` : undefined} />
              <div className="card-pad scroll box-list">
                {!active || !active.boxes.length ? (
                  <Empty title={scanning ? '인식 중이에요…' : '아직 가린 곳이 없어요'}>
                    {scanning ? '잠시만 기다려 주세요. 기기 안에서만 처리됩니다.' : '이미지 위를 드래그해서 가릴 영역을 그려 보세요.'}
                  </Empty>
                ) : (
                  <ul className="entity-list">
                    {boxesSorted.map((b) => {
                      const off = active.disabled.has(b.id)
                      return (
                        <li key={b.id} className={`g-${groupOf(b)} ${off ? 'off' : ''}`} onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}>
                          <label>
                            <input type="checkbox" checked={!off} onChange={() => toggleBox(b.id)} />
                            <span className="dot" />
                            <span className="entity-type">{typeName(b)}</span>
                            <span className="entity-value">{b.text}</span>
                          </label>
                          <button type="button" className="icon-btn" onClick={() => removeBox(b.id)} aria-label="삭제">
                            <Trash2 size={14} />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              {!barcodeSupported() && (
                <p className="hint card-pad-x">
                  <QrCode size={14} /> 이 브라우저는 QR 코드 자동 감지를 지원하지 않아요. QR은 직접 드래그해 가려 주세요.
                </p>
              )}
            </Card>

            <div className="side-actions">
              <Button variant="secondary" icon={<ImagePlus size={16} />} onClick={() => fileRef.current?.click()}>
                추가
              </Button>
              <Button variant="secondary" icon={<Copy size={16} />} onClick={copyImage} disabled={!active}>
                복사
              </Button>
              <Button variant="primary" icon={<Download size={16} />} onClick={downloadAll} disabled={!items.length}>
                {items.length > 1 ? `모두 저장 (${items.length})` : '저장'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {dropping && <div className="drop-overlay">여기에 놓으세요</div>}
    </div>
  )
}
