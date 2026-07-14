import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PerfOverlay } from './components/PerfOverlay'
import { getRuntimeInfo, type RuntimeInfo } from './runtime/client'
import { useHealth, useEnvironment, useCreateSession, useSessions } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
import { loadKnownProjects, projectId, deriveProjects } from './lib/projects'
import { useGlobalNotifications } from './state/use-global-notifications'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SurfaceSkeleton } from './components/Skeleton'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { TitleBar } from './components/TitleBar'

import { toast } from 'sonner'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ConnectWizard } from './components/ConnectWizard'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutOverlay } from './components/ShortcutOverlay'
import { Toaster } from 'sonner'
import { WallpaperLayer } from './components/WallpaperLayer'
import { WallpaperProvider } from './components/WallpaperContext'
import { useGlobalShortcuts } from './lib/use-global-shortcuts'
import { useSurfaceCommands } from './lib/use-surface-commands'
import { openExternal } from './lib/open-external'
import { ProjectTemplatesDialog } from './components/ProjectTemplatesDialog'
import { FirstRunStorageDialog } from './components/FirstRunStorageDialog'
import { FirstRunGitDialog } from './components/FirstRunGitDialog'
import { RecordingBar } from './components/RecordingBar'
import { useProLicense } from './lib/use-activation-gate'
import { applyProjectTemplates, getProjectTemplatesStatus, isStorageConfigured, fixAutocrlf } from './runtime/client'
import type { ProjectTemplatesStatus } from './runtime/types'

export function App() {
  const { t } = useTranslation('shell')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const env = useEnvironment()
  const createSession = useCreateSession()
  const sessions = useSessions()
  useGlobalNotifications()
  // 双层模式：Basic 免许可证即用。此处只为 app 级心跳（滚动续期/吊销检测）
  // 常驻；层级展示与升级入口在 设置 → 关于与许可。
  useProLicense()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  useGlobalShortcuts(setPaletteOpen, setShortcutsOpen)
  const commands = useSurfaceCommands()


  const sidecarDown = health.isError
  const needsSetup = !sidecarDown && health.data?.configured === false
  const [setupDismissed, setSetupDismissed] = useState(false)
  const connectAutoShown = useRef(false)
  const [envDismissed, setEnvDismissed] = useState(false)
  const [gitGateDismissed, setGitGateDismissed] = useState(false)
  const [templatesStatus, setTemplatesStatus] = useState<ProjectTemplatesStatus | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [storageConfigured, setStorageConfigured] = useState<boolean | null>(null)

  // W2 — sidecar crash auto-recovery: the Rust shell respawns a crashed sidecar
  // on the same port/token and emits `sidecar-restarted` once it passes /health
  // again. When crashes exceed the restart budget (3 per 10min) the monitor
  // emits `sidecar-gave-up` and stops — without surfacing that, the UI keeps
  // showing "正在重连…" forever while nothing is actually reconnecting.
  const [sidecarGaveUp, setSidecarGaveUp] = useState(false)
  // Graded supervision (Phase 3): the Rust shell probes /health from outside
  // the Node event loop. 'degraded' = alive but unresponsive ~10s (yellow
  // banner, self-clears on 'recovered'); 'hung' = unresponsive ~60s WITH runs
  // in flight — auto-restart would kill them, so the user decides.
  const [sidecarDegraded, setSidecarDegraded] = useState(false)
  const [sidecarHungRuns, setSidecarHungRuns] = useState<number | null>(null)
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const unlisteners: (() => void)[] = []
    let cancelled = false
    void import('@tauri-apps/api/event')
      .then(async (m) => {
        const offRestarted = await m.listen('sidecar-restarted', async () => {
          setSidecarGaveUp(false)
          setSidecarDegraded(false)
          setSidecarHungRuns(null)
          // Verify the respawned sidecar actually resolved a usable key. If the
          // restart dropped auth (e.g. an apiKeyEnv provider whose env was lost),
          // say so plainly — the persistent `needsSetup` banner below then guides
          // reconfiguration, instead of the user hitting silent 401s on every send.
          const res = await health.refetch()
          if (res.data && res.data.configured === false) {
            toast.warning(t('toast.runtimeRestoredNoKey'))
          } else {
            toast.success(t('toast.runtimeRestored'))
          }
        })
        const offGaveUp = await m.listen('sidecar-gave-up', () => {
          setSidecarGaveUp(true)
        })
        const offDegraded = await m.listen('sidecar-degraded', () => {
          setSidecarDegraded(true)
        })
        const offRecovered = await m.listen('sidecar-recovered', () => {
          setSidecarDegraded(false)
          setSidecarHungRuns(null)
        })
        const offHung = await m.listen<number>('sidecar-hung', (ev) => {
          setSidecarHungRuns(typeof ev.payload === 'number' ? ev.payload : 0)
        })
        if (cancelled) {
          offRestarted()
          offGaveUp()
          offDegraded()
          offRecovered()
          offHung()
        } else {
          unlisteners.push(offRestarted, offGaveUp, offDegraded, offRecovered, offHung)
        }
      })
      .catch(() => {})
    return () => { cancelled = true; unlisteners.forEach((off) => off()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    isStorageConfigured()
      .then((configured) => setStorageConfigured(configured))
      .catch(() => {
        // Sidecar not ready yet or check failed — keep null (loading) so we
        // don't silently skip the first-run dialog. The dialog gate checks
        // `storageConfigured === false`, so null means "still deciding".
      })
  }, [])

  const activeProjectCwd = useMemo(() => {
    if (!ui.activeProject) return null
    const list = sessions.data ?? []
    const p = deriveProjects(list, loadKnownProjects()).find((x) => x.id === ui.activeProject)
    return p?.roots[0] ?? null
  }, [sessions.data, ui.activeProject])

  useEffect(() => {
    if (!activeProjectCwd) {
      setTemplatesStatus(null)
      setTemplatesOpen(false)
      return
    }
    let cancelled = false
    getProjectTemplatesStatus(activeProjectCwd)
      .then((status) => {
        if (cancelled) return
        setTemplatesStatus(status)
        if (status.needsInit) setTemplatesOpen(true)
      })
      .catch(() => {
        // Best-effort: don't block project loading on template check failure.
      })
    return () => { cancelled = true }
  }, [activeProjectCwd])
  // Fatal start failure (Rust reported ready=false). IMPORTANT: Rust's readiness
  // probe is a one-shot ~15s gate, and a cold launch (many sessions rehydrating,
  // cold disk) can lose that race even though the sidecar comes up moments later.
  // So treat ready===false as a *hint*, not a verdict:
  //   1. live /health is ground truth — clear the fatal flag the instant the
  //      sidecar answers, so a slow-but-successful start self-heals (no manual
  //      restart, no permanently-stuck error banner).
  //   2. only escalate to the fatal banner after a grace window during which the
  //      sidecar is STILL unreachable, so a slow start never flashes "启动失败".
  const [sidecarFailed, setSidecarFailed] = useState(false)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const sidecarHealthyRef = useRef(false)
  useEffect(() => {
    if (health.data?.ok) {
      sidecarHealthyRef.current = true
      setSidecarFailed(false)
    }
  }, [health.data])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    getRuntimeInfo()
      .then((info) => {
        if (cancelled) return
        setRuntimeInfo(info)
        if (info.ready !== false) return
        // Grace window: only mark fatal if the sidecar hasn't answered /health by then.
        timer = setTimeout(() => {
          if (!cancelled && !sidecarHealthyRef.current) setSidecarFailed(true)
        }, 20000)
      })
      .catch(() => { /* browser-dev fallback has no ready flag */ })
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])
  const restartApp = () => {
    void import('@tauri-apps/plugin-process')
      .then((m) => m.relaunch())
      .catch(() => window.location.reload())
  }
  // New-thread default cwd. The bug: this used to resolve ONLY from
  // loadKnownProjects(), so a project that exists only from past sessions (never
  // opened via the folder picker) resolved to null → the dialog sent no cwd →
  // the sidecar fell back to its home-dir cwd, dropping the user out of the
  // project. Resolve from the same sources the sidebar uses:
  //   1. the active thread's own cwd (new thread in the project you're viewing);
  //   2. the active project's root via deriveProjects(known ∪ session-derived).
  const defaultCwd = useMemo(() => {
    const list = sessions.data ?? []
    const active = list.find((s) => s.id === ui.activeSessionId)
    if (active?.cwd) return active.cwd
    if (ui.activeProject) {
      const p = deriveProjects(list, loadKnownProjects()).find((x) => x.id === ui.activeProject)
      if (p?.roots[0]) return p.roots[0]
    }
    return null
  }, [sessions.data, ui.activeSessionId, ui.activeProject])

  // U3: transient error banner auto-dismisses after 5s and can be closed manually.
  useEffect(() => {
    if (!ui.error) return
    const t = setTimeout(() => dispatch({ type: 'setError', error: null }), 5000)
    return () => clearTimeout(t)
  }, [ui.error, dispatch])
  const dismissError = () => dispatch({ type: 'setError', error: null })

  // 首次启动且尚未配置任何可用服务商时，自动弹出连接向导（每次启动只弹一次）。
  useEffect(() => {
    if (needsSetup && !connectAutoShown.current) {
      connectAutoShown.current = true
      dispatch({ type: 'openConnect', open: true })
    }
  }, [needsSetup, dispatch])

  return (
    <WallpaperProvider>
      <PerfOverlay />
      <div className="shell">
        <TitleBar />
        <WallpaperLayer />
      <div className="main">
        {sidecarGaveUp && sidecarDown ? (
          <div className="banner error">
            {t('banner.sidecarGaveUp')}
            <button className="banner-action" onClick={restartApp}>{t('banner.restartApp')}</button>
          </div>
        ) : (sidecarFailed || (runtimeInfo?.ready === false && !sidecarHealthyRef.current)) && sidecarDown ? (
          <div className="banner error">
            {t('banner.sidecarFailed')}
            {runtimeInfo?.spawnError && (
              <span className="banner-detail" title={runtimeInfo.spawnError}>
                {runtimeInfo.spawnError.slice(0, 120)}
                {runtimeInfo.spawnError.length > 120 ? '…' : ''}
              </span>
            )}
            {runtimeInfo?.logPath && (
              <span className="banner-detail" title={runtimeInfo.logPath}>
                日志: {runtimeInfo.logPath}
              </span>
            )}
            <button className="banner-action" onClick={restartApp}>{t('banner.restartApp')}</button>
          </div>
        ) : sidecarDown ? (
          <div className="banner error">{t('banner.sidecarReconnecting')}</div>
        ) : null}
        {sidecarHungRuns !== null ? (
          <div className="banner error">
            {t('banner.sidecarHung', { count: sidecarHungRuns })}
            <button className="banner-action" onClick={restartApp}>{t('banner.restartApp')}</button>
            <button className="banner-close" onClick={() => setSidecarHungRuns(null)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        ) : sidecarDegraded ? (
          <div className="banner warn">{t('banner.sidecarDegraded')}</div>
        ) : null}
        {needsSetup && !setupDismissed && (
          <div className="banner warn">
            {t('banner.needsSetup')}
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'openConnect', open: true })}
            >
              {t('banner.connectModel')}
            </button>
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              {t('banner.goToSettings')}
            </button>
            <button className="banner-close" onClick={() => setSetupDismissed(true)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}
        {env.data && !env.data.python.available && !envDismissed && (
          <div className="banner warn">
            {t('banner.pythonMissing')}
            {env.data.platform === 'darwin' && t('banner.pythonHintMac')}
            {env.data.platform === 'win32' && t('banner.pythonHintWin')}
            {env.data.platform === 'linux' && t('banner.pythonHintLinux')}
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              {t('banner.viewEnvironment')}
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}
        {env.data && env.data.platform === 'win32' && env.data.gitAutocrlf === 'true' && !envDismissed && (
          <div className="banner warn">
            {t('banner.autocrlf')}
            <button
              className="banner-action"
              onClick={async () => {
                try {
                  await fixAutocrlf()
                  await env.refetch()
                  toast.success(t('toast.autocrlfFixed'))
                } catch (e) {
                  toast.error(t('toast.autocrlfFixFailed', { message: (e as Error).message }))
                }
              }}
            >
              {t('banner.oneClickFix')}
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}
        {env.data && !env.data.git.available && !envDismissed && env.data.platform !== 'win32' && (
          <div className="banner warn">
            {t('banner.gitMissing')}
            {env.data.platform === 'darwin' && t('banner.gitHintMac')}
            {env.data.platform === 'linux' && t('banner.gitHintLinux')}
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              {t('banner.viewEnvironment')}
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}
        {env.data && env.data.platform === 'win32' && env.data.shell && !env.data.shell.gitBashAvailable && !envDismissed && (
          <div className="banner warn">
            {t('banner.gitBashMissing', { shell: env.data.shell.kind === 'powershell' ? 'PowerShell' : 'cmd.exe' })}
            <button
              className="banner-action"
              onClick={() => openExternal('https://git-scm.com/download/win')}
            >
              {t('banner.downloadGitWin')}
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}
        {ui.error && (
          <div className="banner error">
            {ui.error}
            <button className="banner-close" onClick={dismissError} aria-label={t('common:close')} title={t('common:close')}>
              ×
            </button>
          </div>
        )}

        <div className="surface">
          <ErrorBoundary label={ui.surface === 'mission' ? t('nav:mission') : t('nav:workspace')}>
            <Suspense fallback={<SurfaceSkeleton />}>
              <WorkspaceSurface />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}

      <ShortcutOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {ui.connectOpen && (
        <ConnectWizard onClose={() => dispatch({ type: 'openConnect', open: false })} />
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
      <ProjectTemplatesDialog
        status={templatesStatus}
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        onApply={async (agentsMode) => {
          if (!activeProjectCwd || !templatesStatus) return
          await applyProjectTemplates(activeProjectCwd, agentsMode)
          setTemplatesStatus((prev) => prev ? { ...prev, needsInit: false } : prev)
        }}
      />
      {storageConfigured === false && (
        <FirstRunStorageDialog open />
      )}
      {storageConfigured === true
        && !sidecarDown
        && env.data
        && env.data.platform === 'win32'
        && !env.data.git.available
        && !gitGateDismissed && (
        <FirstRunGitDialog open onDismiss={() => setGitGateDismissed(true)} />
      )}
      <RecordingBar />
      <Toaster position="top-right" theme="dark" toastOptions={{ style: { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)' } }} />
    </div>
    </WallpaperProvider>
  )
}

