import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { getRuntimeInfo } from './runtime/client'
import { useHealth, useEnvironment, useCreateSession, useSessions } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
import { loadKnownProjects, projectId, deriveProjects } from './lib/projects'
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
import { ProjectTemplatesDialog } from './components/ProjectTemplatesDialog'
import { applyProjectTemplates, getProjectTemplatesStatus } from './runtime/client'
import type { ProjectTemplatesStatus } from './runtime/types'

export function App() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const env = useEnvironment()
  const createSession = useCreateSession()
  const sessions = useSessions()
  useGlobalNotifications()

  const [paletteOpen, setPaletteOpen] = useState(false)
  useGlobalShortcuts(setPaletteOpen)
  const commands = useSurfaceCommands()


  const sidecarDown = health.isError
  const needsSetup = !sidecarDown && health.data?.configured === false
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [envDismissed, setEnvDismissed] = useState(false)
  const [templatesStatus, setTemplatesStatus] = useState<ProjectTemplatesStatus | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)

  useEffect(() => {
    if (!ui.activeProject) {
      setTemplatesStatus(null)
      setTemplatesOpen(false)
      return
    }
    let cancelled = false
    getProjectTemplatesStatus(ui.activeProject)
      .then((status) => {
        if (cancelled) return
        setTemplatesStatus(status)
        if (status.needsInit) setTemplatesOpen(true)
      })
      .catch(() => {
        // Best-effort: don't block project loading on template check failure.
      })
    return () => { cancelled = true }
  }, [ui.activeProject])
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
        if (cancelled || info.ready !== false) return
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

  return (
    <WallpaperProvider>
      <div className="shell">
        <WallpaperLayer />
      <div className="main">
        {sidecarFailed && sidecarDown ? (
          <div className="banner error">
            sidecar 启动失败：未找到 Node 运行时或端口被占用。请重启应用，若仍失败请检查安装。
            <button className="banner-action" onClick={restartApp}>重启应用</button>
          </div>
        ) : sidecarDown ? (
          <div className="banner error">sidecar 未启动，正在重连…</div>
        ) : null}
        {needsSetup && !setupDismissed && (
          <div className="banner warn">
            未配置 DeepSeek API Key，无法开始对话或委派子代理。请在设置中填入 Key（子代理推荐使用 deepseek-v4-flash）。
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
        {env.data && !env.data.python.available && !envDismissed && (
          <div className="banner warn">
            未检测到 Python。运行 Python 脚本或项目前请先安装 Python。
            {env.data.platform === 'darwin' && 'macOS 推荐：brew install python'}
            {env.data.platform === 'win32' && 'Windows 推荐：Microsoft Store 安装 Python 3.12'}
            {env.data.platform === 'linux' && 'Linux 推荐：sudo apt install python3 python3-pip'}
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              查看环境
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label="关闭" title="关闭">
              ×
            </button>
          </div>
        )}
        {env.data && !env.data.git.available && !envDismissed && (
          <div className="banner warn">
            未检测到 Git。代码仓库操作需要 Git。
            {env.data.platform === 'darwin' && 'macOS 推荐：xcode-select --install 或 brew install git'}
            {env.data.platform === 'win32' && 'Windows 推荐：从 git-scm.com/download/win 下载安装'}
            {env.data.platform === 'linux' && 'Linux 推荐：sudo apt install git'}
            <button
              className="banner-action"
              onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
            >
              查看环境
            </button>
            <button className="banner-close" onClick={() => setEnvDismissed(true)} aria-label="关闭" title="关闭">
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
      <ProjectTemplatesDialog
        status={templatesStatus}
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        onApply={async (agentsMode) => {
          if (!ui.activeProject || !templatesStatus) return
          await applyProjectTemplates(ui.activeProject, agentsMode)
          setTemplatesStatus((prev) => prev ? { ...prev, needsInit: false } : prev)
        }}
      />
      <Toaster position="top-right" theme="dark" toastOptions={{ style: { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)' } }} />
    </div>
    </WallpaperProvider>
  )
}

