import { useMemo, useState } from 'react'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import { TYPE_META } from '../core/labels'
import { entityKey } from '../core/mask'
import type { Entity, EntityType } from '../core/types'
import { ALL_TYPES } from '../core/engine'

export interface EntityGroupItem {
  key: string
  value: string
  count: number
  confidence: Entity['confidence']
  note?: string
  label?: string
  replacement?: string
}

interface Props {
  entities: Entity[]
  disabledKeys: ReadonlySet<string>
  replacements: Map<string, string>
  onToggle: (keys: string[], enable: boolean) => void
  onHover?: (key: string | null) => void
}

const CONF_LABEL = { high: '확실', medium: '유력', low: '추정' } as const

function groupEntities(entities: Entity[]) {
  const groups = new Map<EntityType, Map<string, EntityGroupItem>>()
  for (const e of entities) {
    const key = entityKey(e.type, e.value, e.label)
    let g = groups.get(e.type)
    if (!g) groups.set(e.type, (g = new Map()))
    const item = g.get(key)
    if (item) {
      item.count++
      if (e.confidence === 'high' || (e.confidence === 'medium' && item.confidence === 'low')) item.confidence = e.confidence
    } else {
      g.set(key, { key, value: e.value, count: 1, confidence: e.confidence, note: e.note, label: e.label })
    }
  }
  return ALL_TYPES.filter((t) => groups.has(t)).map((t) => ({ type: t, items: [...groups.get(t)!.values()] }))
}

export function EntityPanel({ entities, disabledKeys, replacements, onToggle, onHover }: Props) {
  const groups = useMemo(() => groupEntities(entities), [entities])
  const [collapsed, setCollapsed] = useState<Set<EntityType>>(new Set())

  if (!groups.length) {
    return (
      <div className="entity-empty">
        <ShieldCheck size={22} />
        <p>
          아직 찾은 개인정보가 없어요.
          <br />
          <span>원문을 붙여넣으면 이곳에 항목별로 정리됩니다.</span>
        </p>
      </div>
    )
  }

  return (
    <div className="entity-groups">
      {groups.map(({ type, items }) => {
        const meta = TYPE_META[type]
        const onCount = items.filter((i) => !disabledKeys.has(i.key)).length
        const allOn = onCount === items.length
        const isCollapsed = collapsed.has(type)
        return (
          <div key={type} className={`entity-group g-${meta.group}`}>
            <div className="entity-group-head">
              <button
                type="button"
                className="entity-group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((prev) => {
                    const n = new Set(prev)
                    if (n.has(type)) n.delete(type)
                    else n.add(type)
                    return n
                  })
                }
              >
                <ChevronDown size={16} className={`chev ${isCollapsed ? 'rot' : ''}`} />
                <span className="dot" />
                <span className="entity-group-name">{type === 'custom' ? '직접 지정' : meta.name}</span>
                <span className="entity-group-count">
                  {onCount}/{items.length}
                </span>
              </button>
              <label className="mini-check" title={allOn ? '이 유형 모두 가리지 않기' : '이 유형 모두 가리기'}>
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = onCount > 0 && !allOn
                  }}
                  onChange={(e) => onToggle(items.map((i) => i.key), e.target.checked)}
                />
                <span className="sr-only">{meta.name} 전체 선택</span>
              </label>
            </div>
            {!isCollapsed && (
              <ul className="entity-list">
                {items.map((item) => {
                  const on = !disabledKeys.has(item.key)
                  return (
                    <li
                      key={item.key}
                      className={on ? '' : 'off'}
                      onMouseEnter={() => onHover?.(item.key)}
                      onMouseLeave={() => onHover?.(null)}
                    >
                      <label>
                        <input type="checkbox" checked={on} onChange={(e) => onToggle([item.key], e.target.checked)} />
                        <span className="entity-value" title={item.note}>
                          {item.value.length > 60 ? item.value.slice(0, 60) + '…' : item.value}
                        </span>
                        {item.count > 1 && <span className="entity-count">×{item.count}</span>}
                        <span className={`conf conf-${item.confidence}`} title={item.note}>
                          {CONF_LABEL[item.confidence]}
                        </span>
                      </label>
                      {on && replacements.get(item.key) && <div className="entity-repl">→ {replacements.get(item.key)}</div>}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
