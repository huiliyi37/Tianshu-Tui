import { useMemo, useState } from 'react'
import { useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import type { SessionRecord } from '../runtime/types'

/**
 * Tab bar for open threads. Renders a compact row of session tabs
 * above the active conversation. Click switches; Cmd+W closes.
 * Supports drag-to-reorder (HTML5 Drag API, no deps).
 */
export function ThreadTabs() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const tabSessions = useMemo(() => {
    const list = sessions.data ?? []
    const map = new Map<string, SessionRecord>()
    for (const s of list) map.set(s.id, s)
    return ui.openTabs.map((id) => map.get(id)).filter(Boolean) as SessionRecord[]
  }, [ui.openTabs, sessions.data])

  if (tabSessions.length <= 1) return null

  const handleDrop = () => {
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      dispatch({ type: 'reorderTabs', from: dragIndex, to: overIndex })
    }
    setDragIndex(null)
    setOverIndex(null)
  }

  return (
    <div className="thread-tabs" role="tablist" aria-label="对话标签">
      {tabSessions.map((s, i) => {
        const active = s.id === ui.activeSessionId
        const dragging = dragIndex === i
        const dragOver = overIndex === i && dragIndex !== null && dragIndex !== i
        return (
          <button
            key={s.id}
            className={`thread-tab${active ? ' active' : ''}${dragging ? ' dragging' : ''}${dragOver ? ' drag-over' : ''}`}
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => { e.preventDefault(); setOverIndex(i) }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null) }}
            onDrop={(e) => { e.preventDefault(); handleDrop() }}
            onClick={() => dispatch({ type: 'setActive', id: s.id })}
            onAuxClick={(e) => {
              // Middle-click to close tab
              if (e.button === 1) {
                e.preventDefault()
                dispatch({ type: 'closeTab', id: s.id })
              }
            }}
          >
            <span className="thread-tab-title">
              {s.title ?? s.id.slice(0, 8)}
            </span>
            <span
              className="thread-tab-close"
              aria-label={`关闭 ${s.title ?? s.id.slice(0, 8)}`}
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'closeTab', id: s.id })
              }}
            >
              ×
            </span>
          </button>
        )
      })}
    </div>
  )
}
