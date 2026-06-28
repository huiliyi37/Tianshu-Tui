import { Suspense, useEffect, useMemo, useState } from 'react'
import { useHealth, useCreateSession } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
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

        <div className="surface">
          <ErrorBoundary label="工作台">
            <Suspense fallback={<div className="surface-loading">加载中…</div>}>
              <WorkspaceSurface />
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

