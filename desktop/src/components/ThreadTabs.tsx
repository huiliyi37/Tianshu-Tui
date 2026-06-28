import { useMemo, useState } from 'react'
import { useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import type { SessionRecord } from '../runtime/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

/**
 * Tab bar for open threads. Renders a compact row of session tabs
 * above the active conversation. Click switches; Cmd+W closes.
 * Supports drag-to-reorder (HTML5 Drag API, no deps) and a right-click
 * context menu for common tab actions.
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
      const fromId = tabSessions[dragIndex]?.id
      const toId = tabSessions[overIndex]?.id
      if (!fromId || !toId) return
      const fromTab = ui.openTabs.indexOf(fromId)
      const toTab = ui.openTabs.indexOf(toId)
      if (fromTab < 0 || toTab < 0) return
      dispatch({ type: 'reorderTabs', from: fromTab, to: toTab })
    }
    setDragIndex(null)
    setOverIndex(null)
  }

  const closeOthers = (keepId: string) => {
    for (const id of ui.openTabs) {
      if (id !== keepId) dispatch({ type: 'closeTab', id })
    }
  }

  const closeToRight = (anchorId: string) => {
    const idx = ui.openTabs.indexOf(anchorId)
    if (idx < 0) return
    const toClose = ui.openTabs.slice(idx + 1)
    for (const id of toClose) dispatch({ type: 'closeTab', id })
  }

  const copyTitle = (title: string) => {
    void navigator.clipboard.writeText(title)
  }

  return (
    <div className="thread-tabs" role="tablist" aria-label="对话标签">
      {tabSessions.map((s, i) => {
        const active = s.id === ui.activeSessionId
        const dragging = dragIndex === i
        const dragOver = overIndex === i && dragIndex !== null && dragIndex !== i
        const title = s.title ?? s.id.slice(0, 8)
        const tabClass = `thread-tab${active ? ' active' : ''}${dragging ? ' dragging' : ''}${dragOver ? ' drag-over' : ''}`
        return (
          <ContextMenu key={s.id}>
            <ContextMenuTrigger
              render={
                <button
                  className={tabClass}
                  role="tab"
                  aria-selected={active}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => { e.preventDefault(); setOverIndex(i) }}
                  onDragEnd={() => { setDragIndex(null); setOverIndex(null) }}
                  onDrop={(e) => { e.preventDefault(); handleDrop() }}
                  onClick={() => dispatch({ type: 'setActive', id: s.id })}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      dispatch({ type: 'closeTab', id: s.id })
                    }
                  }}
                >
                  {s.domainGlyph && (
                    <span className={`thread-tab-glyph domain-accent-${s.domainAccent}`} aria-hidden>
                      {s.domainGlyph}
                    </span>
                  )}
                  <span className="thread-tab-title">{title}</span>
                  <span
                    className="thread-tab-close"
                    aria-label={`关闭 ${title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      dispatch({ type: 'closeTab', id: s.id })
                    }}
                  >
                    ×
                  </span>
                </button>
              }
            />
            <ContextMenuContent align="start" side="bottom" sideOffset={4}>
              <ContextMenuItem onClick={() => copyTitle(title)}>
                复制标题
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => dispatch({ type: 'closeTab', id: s.id })}>
                关闭
              </ContextMenuItem>
              <ContextMenuItem onClick={() => closeOthers(s.id)}>
                关闭其他标签
              </ContextMenuItem>
              <ContextMenuItem onClick={() => closeToRight(s.id)}>
                关闭右侧标签
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
