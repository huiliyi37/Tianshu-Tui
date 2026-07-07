import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { openThreadPopout } from '../lib/popout'
import { isTauri } from '../lib/pty'

/**
 * Tab bar for open threads. Renders a compact row of session tabs
 * above the active conversation. Click switches; Cmd+W closes.
 * Supports drag-to-reorder (HTML5 Drag API, no deps) and a right-click
 * context menu for common tab actions.
 */
export function ThreadTabs() {
  const { t } = useTranslation('shell')
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

  const isWorkspace = ui.surface === 'workspace'

  return (
    <div className="thread-tabs" role="tablist" aria-label={t('tabs.ariaLabel')}>
      {!isWorkspace && (
        <button
          className="thread-tab back-tab"
          onClick={() => dispatch({ type: 'setSurface', surface: 'workspace' })}
          style={{
            marginRight: '8px',
            color: 'var(--accent)',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {t('tabs.backToThread')}
        </button>
      )}
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
                  onClick={() => {
                    dispatch({ type: 'setActive', id: s.id })
                    dispatch({ type: 'setSurface', surface: 'workspace' })
                  }}
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
                    aria-label={t('tabs.closeNamed', { title })}
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
                {t('tabs.copyTitle')}
              </ContextMenuItem>
              {isTauri() && (
                <ContextMenuItem onClick={() => { void openThreadPopout(s.id) }}>
                  {t('tabs.popout')}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => dispatch({ type: 'closeTab', id: s.id })}>
                {t('common:close')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => closeOthers(s.id)}>
                {t('tabs.closeOthers')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => closeToRight(s.id)}>
                {t('tabs.closeToRight')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
