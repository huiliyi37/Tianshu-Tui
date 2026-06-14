import { useHealth, useSessions, useCreateSession } from './state/queries'
import { useUiDispatch, useUiState } from './state/store'
import { Rail } from './components/Rail'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { InboxSurface } from './surfaces/InboxSurface'
import { AutomationsSurface } from './surfaces/AutomationsSurface'
import { SettingsSurface } from './surfaces/SettingsSurface'
import { NewSessionDialog } from './components/NewSessionDialog'

export function App() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const health = useHealth()
  const sessions = useSessions()
  const createSession = useCreateSession()

  const sidecarDown = health.isError
  const attentionCount = (sessions.data ?? []).filter(
    (s) => s.pendingApprovals > 0 || s.status === 'failed',
  ).length

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
          {ui.surface === 'workspace' && <WorkspaceSurface />}
          {ui.surface === 'automations' && <AutomationsSurface />}
          {ui.surface === 'attention' && <InboxSurface />}
          {ui.surface === 'settings' && <SettingsSurface />}
        </div>
      </div>

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
