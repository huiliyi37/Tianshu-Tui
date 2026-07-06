import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiDispatch } from '../state/store'
import { useSessions } from '../state/queries'
import { deriveProjects, loadKnownProjects, projectId } from './projects'
import { loadThemePref, setThemePref, type ThemePref } from './theme'
import { SURFACE_ORDER } from './use-global-shortcuts'
import type { Command } from './commands'

const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino']

function nextTheme(p: ThemePref): ThemePref {
  const i = THEME_CYCLE.indexOf(p)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]!
}

/** Build the Command Palette item list: surfaces, projects, threads, actions. */
export function useSurfaceCommands(): Command[] {
  const { t: tNav } = useTranslation('nav')
  const { t: tCmd } = useTranslation('commandPalette')
  const dispatch = useUiDispatch()
  const sessions = useSessions()

  const jumpTo = (cwd: string, id: string) => {
    dispatch({ type: 'setProject', projectId: projectId(cwd) })
    dispatch({ type: 'setActive', id })
    dispatch({ type: 'setSurface', surface: 'workspace' })
  }

  return useMemo(() => {
    const list = sessions.data ?? []
    const cmds: Command[] = [
      {
        id: 'new-thread',
        label: tCmd('newThread'),
        hint: tCmd('hintAction'),
        run: () => dispatch({ type: 'openNew', open: true }),
      },
      {
        id: 'switch-model',
        label: tCmd('switchModel'),
        hint: tCmd('hintAction'),
        subMode: 'switch-model',
        run: () => {},
      },
      {
        id: 'connect-model',
        label: tCmd('connectProvider'),
        hint: tCmd('hintAction'),
        run: () => dispatch({ type: 'openConnect', open: true }),
      },
      {
        id: 'open-file',
        label: tCmd('openFile'),
        hint: tCmd('hintAction'),
        subMode: 'open-file',
        run: () => {},
      },
      {
        id: 'theme',
        label: tCmd('switchTheme'),
        hint: tCmd('hintAppearance'),
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
        id: `proj-${p.id}`,
        label: tCmd('project', { name: p.name }),
        hint: tCmd('hintProject'),
        run: () => dispatch({ type: 'setProject', projectId: projectId(p.roots[0] ?? '') }),
      })
    }

    for (const s of list) {
      cmds.push({
        id: `thread-${s.id}`,
        label: tCmd('thread', { name: s.title ?? s.id.slice(0, 8) }),
        hint: tCmd('hintJump'),
        run: () => jumpTo(s.cwd, s.id),
      })
    }

    return cmds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.data, dispatch, tNav, tCmd])
}
