import { useHealth } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { InboxSurface } from './surfaces/InboxSurface'
import { ScheduleSurface } from './surfaces/ScheduleSurface'
import { NewSessionDialog } from './components/NewSessionDialog'
import { useCreateSession } from './state/queries'

export function App() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const createSession = useCreateSession()

  const sidecarDown = health.isError

  return (
    <div className="shell">
      <nav className="topnav">
        <div className="brand">天枢 · Tianshu</div>
        <div className="nav-tabs">
          {(['workspace', 'inbox', 'schedule'] as const).map((s) => (
            <button
              key={s}
              className={`nav-tab ${ui.surface === s ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'setSurface', surface: s })}
            >
              {s === 'workspace' ? '工作台' : s === 'inbox' ? '收件箱' : '定时任务'}
            </button>
          ))}
        </div>
        <div className="health">
          {sidecarDown ? (
            <span className="health-bad">● sidecar 离线，重连中…</span>
          ) : (
            <span className="health-ok">
              ● {health.data?.runningCount ?? 0} 运行 / {health.data?.sessionCount ?? 0} 会话
            </span>
          )}
        </div>
      </nav>

      {ui.error && <div className="banner error">{ui.error}</div>}

      <div className="surface">
        {ui.surface === 'workspace' && <WorkspaceSurface />}
        {ui.surface === 'inbox' && <InboxSurface />}
        {ui.surface === 'schedule' && <ScheduleSurface />}
      </div>

      {ui.newSessionOpen && (
        <NewSessionDialog
          onCreate={async (input) => {
            try {
              const rec = await createSession.mutateAsync(input)
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
