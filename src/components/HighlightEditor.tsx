import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react'
import { TYPE_META } from '../core/labels'
import type { Entity } from '../core/types'

export interface HighlightEditorHandle {
  focus: () => void
  getSelection: () => { start: number; end: number } | null
}

interface Props {
  value: string
  onChange: (v: string) => void
  entities: Entity[]
  isDisabled: (e: Entity) => boolean
  placeholder?: string
  onSelect?: (sel: { start: number; end: number; text: string } | null) => void
  ariaLabel?: string
}

/**
 * A textarea with a synchronised backdrop that paints highlights under detected entities.
 * The textarea stays fully native (IME, undo, mobile keyboards all keep working).
 */
export const HighlightEditor = forwardRef<HighlightEditorHandle, Props>(function HighlightEditor(
  { value, onChange, entities, isDisabled, placeholder, onSelect, ariaLabel },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const backRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    getSelection: () => {
      const ta = taRef.current
      if (!ta || ta.selectionStart === ta.selectionEnd) return null
      return { start: ta.selectionStart, end: ta.selectionEnd }
    },
  }))

  const syncScroll = useCallback(() => {
    if (taRef.current && backRef.current) {
      backRef.current.scrollTop = taRef.current.scrollTop
      backRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }, [])

  const backdrop = useMemo(() => {
    const parts: ReactNode[] = []
    let cursor = 0
    for (const e of entities) {
      if (e.start < cursor) continue
      if (e.start > cursor) parts.push(value.slice(cursor, e.start))
      const off = isDisabled(e)
      parts.push(
        <mark key={e.id} className={`hl g-${TYPE_META[e.type].group} ${off ? 'off' : ''} conf-${e.confidence}`}>
          {value.slice(e.start, e.end)}
        </mark>,
      )
      cursor = e.end
    }
    parts.push(value.slice(cursor))
    // trailing newline needs a character so the backdrop height matches the textarea
    parts.push('​')
    return parts
  }, [value, entities, isDisabled])

  const handleSelect = () => {
    const ta = taRef.current
    if (!ta || !onSelect) return
    if (ta.selectionStart === ta.selectionEnd) onSelect(null)
    else onSelect({ start: ta.selectionStart, end: ta.selectionEnd, text: value.slice(ta.selectionStart, ta.selectionEnd) })
  }

  return (
    <div className="hl-editor">
      <div className="hl-backdrop" ref={backRef} aria-hidden="true">
        <div className="hl-content">{backdrop}</div>
      </div>
      <textarea
        ref={taRef}
        className="hl-textarea"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onSelect={handleSelect}
        onKeyUp={handleSelect}
        onMouseUp={handleSelect}
      />
    </div>
  )
})
