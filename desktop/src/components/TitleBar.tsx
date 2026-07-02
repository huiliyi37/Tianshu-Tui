import { useCallback, useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { useUiState } from '../state/store'
import { useRenameSession, useSessions } from '../state/queries'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const IS_WIN = typeof navigator !== 'undefined' && /Win/.test(navigator.userAgent)
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Custom title bar is only drawn on Windows, where tauri.windows.conf.json
    sets decorations: false. macOS keeps native traffic lights via Overlay;
    Linux keeps full native decorations. */
export const HAS_CUSTOM_TITLEBAR = IS_TAURI && IS_WIN

/**
 * P2-2 — window chrome for the island design language.
 *
 * - Windows (decorations: false): self-drawn bar — logo + renamable
 *   session title on the left, min/max/close on the right (Windows-style
 *   red-hover close). `data-tauri-drag-region` gives drag + dblclick-maximize.
 * - macOS (titleBarStyle: Overlay): a slim always-present drag strip that also
 *   clears the native traffic lights (the sidebar is collapsible, so no panel
 *   can be relied on for clearance).
 * - Both: mirrors the maximized state onto `html[data-maximized]` so CSS can
 *   collapse island gaps/radii when the window fills the screen.
 */
export function TitleBar() {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.platform = IS_MAC ? 'mac' : 'other'
    if (HAS_CUSTOM_TITLEBAR) root.dataset.titlebar = 'custom'
    else if (IS_TAURI && IS_MAC) root.dataset.titlebar = 'mac'
  }, [])

  // Track maximized state → html[data-maximized] (islands go edge-to-edge).
  useEffect(() => {
    if (!IS_TAURI) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void import('@tauri-apps/api/window').then(async (m) => {
      const win = m.getCurrentWindow()
      const sync = async () => {
        const max = await win.isMaximized().catch(() => false)
        document.documentElement.toggleAttribute('data-maximized', max)
      }
      await sync()
      const off = await win.onResized(() => { void sync() })
      if (cancelled) off()
      else unlisten = off
    }).catch(() => {})
    return () => { cancelled = true; unlisten?.() }
  }, [])

  if (HAS_CUSTOM_TITLEBAR) return <WindowsTitleBar />
  // macOS: slim drag strip under the native Overlay traffic lights.
  if (IS_TAURI && IS_MAC) return <header className="titlebar-mac" data-tauri-drag-region />
  return null
}

function WindowsTitleBar() {
  const ui = useUiState()
  const sessions = useSessions()
  const renameSession = useRenameSession()
  const active = sessions.data?.find((s) => s.id === ui.activeSessionId) ?? null
  const [editing, setEditing] = useState(false)

  const winCall = useCallback((fn: 'minimize' | 'toggleMaximize' | 'close') => {
    void import('@tauri-apps/api/window')
      .then((m) => m.getCurrentWindow()[fn]())
      .catch(() => {})
  }, [])

  const commitRename = (title: string) => {
    setEditing(false)
    const t = title.trim()
    if (active && t && t !== active.title) renameSession.mutate({ id: active.id, title: t })
  }

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="titlebar-logo" aria-hidden>✦</span>
        {active && (
          editing ? (
            <input
              className="titlebar-title-input"
              defaultValue={active.title ?? ''}
              autoFocus
              onBlur={(e) => commitRename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
                else if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <button
              className="titlebar-title"
              onClick={() => setEditing(true)}
              title="点击重命名会话"
            >
              {active.title ?? active.id.slice(0, 8)}
            </button>
          )
        )}
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => winCall('minimize')} aria-label="最小化" title="最小化">
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button className="titlebar-btn" onClick={() => winCall('toggleMaximize')} aria-label="最大化/还原" title="最大化/还原">
          <MaximizeGlyph />
        </button>
        <button className="titlebar-btn close" onClick={() => winCall('close')} aria-label="关闭" title="关闭">
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  )
}

/** Swaps the maximize glyph to "restore" (two squares) while maximized. */
function MaximizeGlyph() {
  const [maximized, setMaximized] = useState(
    () => document.documentElement.hasAttribute('data-maximized'),
  )
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setMaximized(document.documentElement.hasAttribute('data-maximized'))
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-maximized'] })
    return () => mo.disconnect()
  }, [])
  return maximized
    ? <Copy size={12} strokeWidth={1.5} style={{ transform: 'scaleX(-1)' }} />
    : <Square size={12} strokeWidth={1.5} />
}
