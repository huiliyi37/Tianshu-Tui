import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiDispatch } from '../state/store'
import { useSessions } from '../state/queries'
import { deriveProjects, loadKnownProjects } from './projects'
import { loadThemePref, setThemePref, type ThemePref } from './theme'
import { SURFACE_ORDER } from './use-global-shortcuts'
import type { Command } from './commands'

function nextTheme(p: ThemePref): ThemePref {
  return p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'
}

/** Build the Command Palette item list: surfaces, projects, threads, actions. */
export function useSurfaceCommands(): Command[] {
  const { t: tNav } = useTranslation('nav')
  const { t: tCmd } = useTranslation('commandPalette')
  const dispatch = useUiDispatch()
  const sessions = useSessions()

  const jumpTo = (cwd: string, id: string) => {
    dispatch({ type: 'setProject', cwd })
    dispatch({ type: 'setActive', id })
    dispatch({ type: 'setSurface', surface: 'workspace' })
  }

  return useMemo(() => {
    const list = sessions.data ?? []
    const cmds: Command[] = [
      {
        id: 'new-thread',
        label: '新建线程',
        hint: '操作',
        run: () => dispatch({ type: 'openNew', open: true }),
      },
      {
        id: 'theme',
        label: '切换主题',
        hint: '外观',
        run: () => setThemePref(nextTheme(loadThemePref())),
      },
    ]

    for (const s of SURFACE_ORDER) {
      cmds.push({
        id: `surface-${s}`,
        label: tCmd('goTo', { label: tNav(s) }),
        hint: tCmd('hintNavigate'),
        run: () => dispatch({ type: 'setSurface', surface: s }),
      })
    }

    for (const p of deriveProjects(list, loadKnownProjects())) {
      cmds.push({
        id: `proj-${p.cwd}`,
        label: `项目：${p.name}`,
        hint: '项目',
        run: () => dispatch({ type: 'setProject', cwd: p.cwd }),
      })
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
  }, [sessions.data, dispatch, tNav, tCmd])
}
