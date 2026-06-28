import { useEffect } from 'react'
import { useUiDispatch, useUiState, type Surface } from '../state/store'

export const SURFACE_ORDER: Surface[] = [
  'workspace',
  'mission',
  'automations',
  'skills',
  'git',
  'insights',
  'delegation',
  'council',
  'hooks',
  'settings',
]

/** Global keyboard shortcuts. Registers a single window keydown listener
 *  so components don't each add their own. */
export function useGlobalShortcuts(setPaletteOpen: (v: boolean | ((p: boolean) => boolean)) => void) {
  const ui = useUiState()
  const dispatch = useUiDispatch()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      // Cmd+K → command palette toggle
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }

      // Cmd+1..9 → switch surface
      if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        dispatch({ type: 'setSurface', surface: SURFACE_ORDER[Number(e.key) - 1]! })
        return
      }

      // Cmd+Shift+[ / ] → cycle tabs (previous / next)
      if (mod && e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const tabs = ui.openTabs
        if (tabs.length < 2) return
        const idx = ui.activeSessionId ? tabs.indexOf(ui.activeSessionId) : -1
        const dir = e.key === '[' ? -1 : 1
        const next = tabs[(idx + dir + tabs.length) % tabs.length]
        if (next) dispatch({ type: 'setActive', id: next })
        return
      }

      // Cmd+Shift+B → toggle review panel (must precede Cmd+B)
      if (mod && e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        dispatch({ type: 'setReview', visible: !ui.reviewVisible })
        dispatch({ type: 'setReviewManual', on: true })
        return
      }

      // Cmd+B → toggle sidebar
      if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        dispatch({ type: 'setSidebar', visible: !ui.sidebarVisible })
        return
      }

      // Cmd+J → toggle terminal
      if (mod && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        dispatch({ type: 'setTerminal', visible: !ui.terminalVisible })
        return
      }

      // Cmd+N → new thread dialog
      if (mod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        dispatch({ type: 'openNew', open: true })
        return
      }

      // Cmd+, → settings surface
      if (mod && e.key === ',') {
        e.preventDefault()
        dispatch({ type: 'setSurface', surface: 'settings' })
        return
      }

      // Cmd+/ → shortcut cheatsheet (opens command palette)
      if (mod && e.key === '/') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }

      // Cmd+W → close current thread tab
      if (mod && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        if (ui.activeSessionId) dispatch({ type: 'closeTab', id: ui.activeSessionId })
      }
      // Cmd+. → toggle Zen mode (hide sidebar + review for distraction-free focus)
      if (mod && e.key === '.') {
        e.preventDefault()
        dispatch({ type: 'toggleZen' })
        return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    dispatch,
    setPaletteOpen,
    ui.activeSessionId,
    ui.openTabs,
    ui.reviewVisible,
    ui.sidebarVisible,
    ui.terminalVisible,
  ])
}
