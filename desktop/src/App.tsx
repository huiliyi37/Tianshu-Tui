import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHealth, useCreateSession, useSessions } from './state/queries'
import { useUiDispatch, useUiState, type Surface } from './state/store'
import { loadKnownProjects, projectId } from './lib/projects'
import { useGlobalNotifications } from './state/use-global-notifications'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { NewSessionDialog } from './components/NewSessionDialog'
import { CommandPalette } from './components/CommandPalette'
import { Toaster } from 'sonner'
import { WallpaperLayer } from './components/WallpaperLayer'
import { WallpaperProvider } from './components/WallpaperContext'
import { useGlobalShortcuts } from './lib/use-global-shortcuts'
import { useSurfaceCommands } from './lib/use-surface-commands'
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

export function App() {
  const { t: tNav } = useTranslation('nav')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const createSession = useCreateSession()
  useGlobalNotifications()

  const [paletteOpen, setPaletteOpen] = useState(false)
  useGlobalShortcuts(setPaletteOpen)
  const commands = useSurfaceCommands()

  const isWorkspaceView = ['workspace', 'skills', 'git', 'insights', 'delegation', 'council', 'hooks'].includes(ui.surface)

  const sidecarDown = health.isError
  const defaultCwd = useMemo(() => {
    if (!ui.activeProject) return null
    const known = loadKnownProjects()
    const p = known.find((x) => x.id === ui.activeProject)
    return p?.roots[0] ?? null
  }, [ui.activeProject])

  // U3: transient error banner auto-dismisses after 5s and can be closed manually.
  useEffect(() => {
    if (!ui.error) return
    const t = setTimeout(() => dispatch({ type: 'setError', error: null }), 5000)
    return () => clearTimeout(t)
  }, [ui.error, dispatch])
  const dismissError = () => dispatch({ type: 'setError', error: null })

  return (
    <WallpaperProvider>
      <div className="shell">
        <WallpaperLayer />
      <div className="main">
        {sidecarDown && (
          <div className="banner error">sidecar 离线，重连中…</div>
        )}
        {ui.error && (
          <div className="banner error">
            {ui.error}
            <button className="banner-close" onClick={dismissError} aria-label="关闭" title="关闭">
              ×
            </button>
          </div>
        )}

        {!isWorkspaceView && (
          <header className="surface-topbar">
            <div className="surface-topbar-left">
              <button
                className="surface-back"
                onClick={() => dispatch({ type: 'setSurface', surface: 'workspace' })}
                title="返回工作台"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                工作台
              </button>
              <span className="surface-title">{tNav(ui.surface)}</span>
            </div>
            <div className="surface-topbar-right">
              <SurfaceStatChips surface={ui.surface} activeSessionId={ui.activeSessionId} />
            </div>
          </header>
        )}

        <div className="surface">
          <ErrorBoundary label="工作台">
            <Suspense fallback={<div className="surface-loading">加载中…</div>}>
              {isWorkspaceView && <WorkspaceSurface />}
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
          defaultCwd={defaultCwd}
          onCreate={async (input) => {
            try {
              const rec = await createSession.mutateAsync(input)
              if (rec.cwd) dispatch({ type: 'setProject', projectId: projectId(rec.cwd) })
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
      <Toaster position="bottom-right" theme="dark" toastOptions={{ style: { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)' } }} />
    </div>
    </WallpaperProvider>
  )
}

/** Per-surface stat chips shown in the topbar right side. */
function SurfaceStatChips({ surface, activeSessionId }: { surface: Surface; activeSessionId: string | null }) {
  const sessions = useSessions()
  if (surface === 'insights') {
    const count = sessions.data?.length ?? 0
    return (
      <span className="surface-stat">
        <strong>{count}</strong> 个会话
      </span>
    )
  }
  if (surface === 'attention') {
    // Count sessions with attention/blocked status
    const pending = sessions.data?.filter((s: { status: string }) => s.status === 'blocked' || s.status === 'attention').length ?? 0
    return (
      <span className="surface-stat">
        {pending > 0 ? <><strong>{pending}</strong> 需处理</> : '无待处理'}
      </span>
    )
  }
  if (surface === 'git' && activeSessionId) {
    return <span className="surface-stat">Git 状态</span>
  }
  if (surface === 'delegation' && activeSessionId) {
    return <span className="surface-stat">委派树</span>
  }
  if (surface === 'council' && activeSessionId) {
    return <span className="surface-stat">议事会</span>
  }
  return null
}
