import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useHealth, useSessions, useCreateSession } from './state/queries'
import { useUiDispatch, useUiState, type Surface } from './state/store'
import { useGlobalNotifications } from './state/use-global-notifications'
import { deriveAttention } from './lib/attention'
import { deriveProjects, loadKnownProjects } from './lib/projects'
import { loadThemePref, setThemePref, type ThemePref } from './lib/theme'
import type { Command } from './lib/commands'
import { Rail } from './components/Rail'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { NewSessionDialog } from './components/NewSessionDialog'
import { CommandPalette } from './components/CommandPalette'

// L1 #10: 非首屏 Surface 懒加载，减小首屏 chunk
const InboxSurface = lazy(() =>
  import('./surfaces/InboxSurface').then((m) => ({ default: m.InboxSurface })),
)
const AutomationsSurface = lazy(() =>
  import('./surfaces/AutomationsSurface').then((m) => ({ default: m.AutomationsSurface })),
)
const SettingsSurface = lazy(() =>
  import('./surfaces/SettingsSurface').then((m) => ({ default: m.SettingsSurface })),
)

const SURFACE_ORDER: Surface[] = ['workspace', 'automations', 'attention', 'settings']
const SURFACE_LABEL: Record<Surface, string> = {
  workspace: '工作台',
  automations: '自动化',
  attention: '需处理',
  settings: '设置',
}

function nextTheme(p: ThemePref): ThemePref {
  return p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'
}

export function App() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const sessions = useSessions()
  const createSession = useCreateSession()
  useGlobalNotifications()

  const [paletteOpen, setPaletteOpen] = useState(false)

  const sidecarDown = health.isError
  const attentionCount = deriveAttention(
    sessions.data ?? [],
    new Set(ui.attentionSeen),
  ).unseenCount

  // Global shortcuts. All desktop shortcuts register here, in a single
  // handler, to avoid N component-level window.addEventListener calls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // Cmd+K → command palette toggle
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      // Cmd+1..4 → switch surface
      if (mod && !e.shiftKey && e.key >= '1' && e.key <= '4') {
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
      // Cmd+/ → shortcut cheatsheet (via command palette search)
      if (mod && e.key === '/') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      // Cmd+W → close current thread tab
      if (mod && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        if (ui.activeSessionId) dispatch({ type: 'closeTab', id: ui.activeSessionId })
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, ui.sidebarVisible, ui.reviewVisible, ui.terminalVisible, ui.activeSessionId, ui.openTabs])

  const jumpTo = (cwd: string, id: string) => {
    dispatch({ type: 'setProject', cwd })
    dispatch({ type: 'setActive', id })
    dispatch({ type: 'setSurface', surface: 'workspace' })
  }

  const commands: Command[] = useMemo(() => {
    const list = sessions.data ?? []
    const cmds: Command[] = [
      { id: 'new-thread', label: '新建线程', hint: '操作', run: () => dispatch({ type: 'openNew', open: true }) },
      { id: 'theme', label: '切换主题', hint: '外观', run: () => setThemePref(nextTheme(loadThemePref())) },
    ]
    for (const s of SURFACE_ORDER) {
      cmds.push({ id: `surface-${s}`, label: `前往 ${SURFACE_LABEL[s]}`, hint: '导航', run: () => dispatch({ type: 'setSurface', surface: s }) })
    }
    for (const p of deriveProjects(list, loadKnownProjects())) {
      cmds.push({ id: `proj-${p.cwd}`, label: `项目：${p.name}`, hint: '项目', run: () => dispatch({ type: 'setProject', cwd: p.cwd }) })
    }
    for (const s of list) {
      cmds.push({
        id: `thread-${s.id}`,
        label: `线程：${s.title ?? s.id.slice(0, 8)}`,
        hint: '跳转',
        run: () => jumpTo(s.cwd, s.id),
      })
    }
    return cmds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.data, dispatch])

  return (
    <div className="shell">
      <Rail
        surface={ui.surface}
        onSurface={(s) => dispatch({ type: 'setSurface', surface: s })}
        attentionCount={attentionCount}
      />

      <div className="main">
        {sidecarDown && (
          <div className="banner error">sidecar 离线，重连中…</div>
        )}
        {ui.error && <div className="banner error">{ui.error}</div>}

        <div className="surface">
          <ErrorBoundary label="工作台">
            <Suspense fallback={<div className="surface-loading">加载中…</div>}>
              {ui.surface === 'workspace' && <WorkspaceSurface />}
              {ui.surface === 'automations' && <AutomationsSurface />}
              {ui.surface === 'attention' && <InboxSurface />}
              {ui.surface === 'settings' && <SettingsSurface />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}

      {ui.newSessionOpen && (
        <NewSessionDialog
          defaultCwd={ui.activeProject}
          onCreate={async (input) => {
            try {
              const rec = await createSession.mutateAsync(input)
              if (rec.cwd) dispatch({ type: 'setProject', cwd: rec.cwd })
              dispatch({ type: 'setActive', id: rec.id })
              dispatch({ type: 'setSurface', surface: 'workspace' })
              dispatch({ type: 'openNew', open: false })
            } catch (e) {
              dispatch({ type: 'setError', error: (e as Error).message })
            }
          }}
          onClose={() => dispatch({ type: 'openNew', open: false })}
        />
      )}
    </div>
  )
}
