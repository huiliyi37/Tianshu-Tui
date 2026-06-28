import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { getRuntimeInfo } from './runtime/client'
import { useHealth, useCreateSession } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
import { loadKnownProjects, projectId } from './lib/projects'
import { useGlobalNotifications } from './state/use-global-notifications'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'

const MissionControlSurface = lazy(() => import('./surfaces/MissionControlSurface'))
import { NewSessionDialog } from './components/NewSessionDialog'
import { CommandPalette } from './components/CommandPalette'
import { Toaster } from 'sonner'
import { WallpaperLayer } from './components/WallpaperLayer'
import { WallpaperProvider } from './components/WallpaperContext'
import { useGlobalShortcuts } from './lib/use-global-shortcuts'
import { useSurfaceCommands } from './lib/use-surface-commands'

export function App() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const createSession = useCreateSession()
  useGlobalNotifications()

  const [paletteOpen, setPaletteOpen] = useState(false)
  useGlobalShortcuts(setPaletteOpen)
  const commands = useSurfaceCommands()


  const sidecarDown = health.isError
  const needsSetup = !sidecarDown && health.data?.configured === false
  const [setupDismissed, setSetupDismissed] = useState(false)
  // Fatal start failure (Rust reported ready=false): the sidecar never came up,
  // so the reconnect loop can never succeed. Distinguish it from a transient
  // drop so we don't show misleading "正在重连…" copy forever.
  const [sidecarFailed, setSidecarFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    getRuntimeInfo()
      .then((info) => { if (!cancelled && info.ready === false) setSidecarFailed(true) })
      .catch(() => { /* browser-dev fallback has no ready flag */ })
    return () => { cancelled = true }
  }, [])
  const restartApp = () => {
    void import('@tauri-apps/plugin-process')
      .then((m) => m.relaunch())
      .catch(() => window.location.reload())
  }
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
        {sidecarFailed ? (
          <div className="banner error">
            sidecar 启动失败：未找到 Node 运行时或端口被占用。请重启应用，若仍失败请检查安装。
            <button className="banner-action" onClick={restartApp}>重启应用</button>
          </div>
        ) : sidecarDown ? (
          <div className="banner error">sidecar 未启动，正在重连…</div>
        ) : null}
        {needsSetup && !setupDismissed && (
          <div className="banner warn">
            首次使用，请先配置 API Key
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              前往设置
            </button>
            <button className="banner-close" onClick={() => setSetupDismissed(true)} aria-label="关闭" title="关闭">
              ×
            </button>
          </div>
        )}
        {ui.error && (
          <div className="banner error">
            {ui.error}
            <button className="banner-close" onClick={dismissError} aria-label="关闭" title="关闭">
              ×
            </button>
          </div>
        )}

        <div className="surface">
          <ErrorBoundary label={ui.surface === 'mission' ? '任务中控台' : '工作台'}>
            <Suspense fallback={<div className="surface-loading">加载中…</div>}>
              {ui.surface === 'mission' ? <MissionControlSurface /> : <WorkspaceSurface />}
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

