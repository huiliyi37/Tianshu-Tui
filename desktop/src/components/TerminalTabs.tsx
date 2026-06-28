import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, X, TerminalSquare } from 'lucide-react'
import { TerminalPanel } from './TerminalPanel'
import {
  createTerminalTabsState,
  type TerminalTab,
  type TerminalTabsState,
} from '../lib/terminal-tabs-state'

export type { TerminalTab, TerminalTabsState }
export { createTerminalTabsState }

// ── React component ────────────────────────────────────────────

/**
 * TerminalTabs — multi-tab terminal panel (Gap 4).
 *
 * Wraps TerminalPanel: each tab owns an independent PTY session.
 * Tabs are lightweight state (id + cwd + title); the actual xterm/PTY
 * lifecycle stays inside TerminalPanel (one per tab).
 *
 * Non-active terminals are kept mounted but visually hidden (display:none)
 * so their PTY state survives tab switching without re-spawning.
 */
export function TerminalTabs({ cwd }: { cwd: string }) {
  const stateRef = useRef<TerminalTabsState>(null!)
  if (!stateRef.current) stateRef.current = createTerminalTabsState(cwd)
  const state = stateRef.current

  // Force re-render when tabs change
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick(t => t + 1), [])

  // Keep cwd in sync on first tab when project changes
  useEffect(() => {
    if (state.tabs[0]) state.tabs[0].cwd = cwd
  }, [cwd, state])

  const handleAdd = useCallback(() => {
    state.addTab(cwd)
    rerender()
  }, [state, cwd, rerender])

  const handleClose = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    state.closeTab(id)
    rerender()
  }, [state, rerender])

  const handleActivate = useCallback((id: string) => {
    state.setActive(id)
    rerender()
  }, [state, rerender])

  return (
    <div className="terminal-tabs">
      <div className="tt-tab-bar">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tt-tab ${state.activeId === tab.id ? 'active' : ''}`}
            onClick={() => handleActivate(tab.id)}
          >
            <TerminalSquare size={12} className="tt-tab-icon" />
            <span className="tt-tab-title">{tab.title}</span>
            <button
              className="tt-tab-close"
              onClick={(e) => handleClose(tab.id, e)}
              aria-label="关闭终端"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="tt-add" onClick={handleAdd} aria-label="新建终端">
          <Plus size={14} />
        </button>
      </div>
      <div className="tt-terminals">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className="tt-terminal-wrapper"
            style={{ display: state.activeId === tab.id ? 'flex' : 'none' }}
          >
            <TerminalPanel cwd={tab.cwd} ptyId={tab.id} />
          </div>
        ))}
      </div>
    </div>
  )
}
