import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHealth, useCreateSession, useSessions } from './state/queries'
import { useUiDispatch, useUiState, type Surface } from './state/store'
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
const SkillsSurface = lazy(() =>
  import('./surfaces/SkillsSurface').then((m) => ({ default: m.SkillsSurface })),
)
const GitSurface = lazy(() =>
  import('./surfaces/GitSurface').then((m) => ({ default: m.GitSurface })),
)
const InsightsSurface = lazy(() =>
  import('./surfaces/InsightsSurface').then((m) => ({ default: m.InsightsSurface })),
)
const DelegationSurface = lazy(() =>
  import('./surfaces/DelegationSurface').then((m) => ({ default: m.DelegationSurface })),
)
const CouncilSurface = lazy(() =>
  import('./surfaces/CouncilSurface').then((m) => ({ default: m.CouncilSurface })),
)
const HooksSurface = lazy(() =>
  import('./surfaces/HooksSurface').then((m) => ({ default: m.HooksSurface })),
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

  const sidecarDown = health.isError
  return (
    <WallpaperProvider>
      <div className="shell">
        <WallpaperLayer />
      <div className="main">
        {sidecarDown && (
          <div className="banner error">sidecar 离线，重连中…</div>
        )}
        {ui.error && <div className="banner error">{ui.error}</div>}

        {ui.surface !== 'workspace' && (
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
              {ui.surface === 'workspace' && <WorkspaceSurface />}
              {ui.surface === 'automations' && <AutomationsSurface />}
              {ui.surface === 'attention' && <InboxSurface />}
              {ui.surface === 'delegation' && <DelegationSurface />}
              {ui.surface === 'skills' && <SkillsSurface />}
              {ui.surface === 'git' && <GitSurface />}
              {ui.surface === 'insights' && <InsightsSurface />}
              {ui.surface === 'settings' && <SettingsSurface />}
              {ui.surface === 'council' && <CouncilSurface />}
              {ui.surface === 'hooks' && <HooksSurface />}
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
