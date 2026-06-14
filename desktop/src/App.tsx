import { useEffect, useMemo, useState } from 'react'
import { useHealth, useSessions, useCreateSession } from './state/queries'
import { useUiDispatch, useUiState, type Surface } from './state/store'
import { useGlobalNotifications } from './state/use-global-notifications'
import { deriveAttention } from './lib/attention'
import { deriveProjects, loadKnownProjects } from './lib/projects'
import { loadThemePref, setThemePref, type ThemePref } from './lib/theme'
import type { Command } from './lib/commands'
import { Rail } from './components/Rail'
import { WorkspaceSurface } from './surfaces/WorkspaceSurface'
import { InboxSurface } from './surfaces/InboxSurface'
import { AutomationsSurface } from './surfaces/AutomationsSurface'
import { SettingsSurface } from './surfaces/SettingsSurface'
import { NewSessionDialog } from './components/NewSessionDialog'
import { CommandPalette } from './components/CommandPalette'

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

  // Global shortcuts: Cmd/Ctrl+K palette, Cmd/Ctrl+1..4 switch surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (mod && e.key >= '1' && e.key <= '4') {
        e.preventDefault()
        dispatch({ type: 'setSurface', surface: SURFACE_ORDER[Number(e.key) - 1]! })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

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
          {ui.surface === 'workspace' && <WorkspaceSurface />}
          {ui.surface === 'automations' && <AutomationsSurface />}
          {ui.surface === 'attention' && <InboxSurface />}
          {ui.surface === 'settings' && <SettingsSurface />}
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
