import { useMemo } from 'react'
import { useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import type { SessionRecord } from '../runtime/types'

/**
 * Tab bar for open threads. Renders a compact row of session tabs
 * above the active conversation. Click switches; Cmd+W closes.
 */
export function ThreadTabs() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()

  const tabSessions = useMemo(() => {
    const list = sessions.data ?? []
    const map = new Map<string, SessionRecord>()
    for (const s of list) map.set(s.id, s)
    return ui.openTabs.map((id) => map.get(id)).filter(Boolean) as SessionRecord[]
  }, [ui.openTabs, sessions.data])

  if (tabSessions.length <= 1) return null

  return (
    <div className="thread-tabs" role="tablist" aria-label="对话标签">
      {tabSessions.map((s) => {
        const active = s.id === ui.activeSessionId
        return (
          <button
            key={s.id}
            className={`thread-tab${active ? ' active' : ''}`}
            role="tab"
            aria-selected={active}
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
