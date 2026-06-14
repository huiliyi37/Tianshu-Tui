import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import {
  loadActiveProject,
  loadActiveSessionId,
  saveActiveProject,
  saveActiveSessionId,
} from '../lib/persist'

// Codex-style surfaces (P3 vocab): workspace = Project→Thread→Review,
// automations (was schedule), attention (was inbox), settings.
export type Surface = 'workspace' | 'automations' | 'attention' | 'settings'

export interface UiState {
  activeSessionId: string | null
  activeProject: string | null // project cwd
  surface: Surface
  newSessionOpen: boolean
  error: string | null
}

type UiAction =
  | { type: 'setActive'; id: string | null }
  | { type: 'setProject'; cwd: string | null }
  | { type: 'setSurface'; surface: Surface }
  | { type: 'openNew'; open: boolean }
  | { type: 'setError'; error: string | null }

function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'setActive':
      return { ...state, activeSessionId: action.id }
    case 'setProject':
      // Switching project drops the active thread; it belongs to another project.
      return { ...state, activeProject: action.cwd, activeSessionId: null }
    case 'setSurface':
      return { ...state, surface: action.surface }
    case 'openNew':
      return { ...state, newSessionOpen: action.open }
    case 'setError':
      return { ...state, error: action.error }
    default:
      return state
  }
}

const StateCtx = createContext<UiState | null>(null)
const DispatchCtx = createContext<React.Dispatch<UiAction> | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    activeSessionId: loadActiveSessionId(),
    activeProject: loadActiveProject(),
    surface: 'workspace' as Surface,
    newSessionOpen: false,
    error: null,
  }))

  useEffect(() => {
    saveActiveSessionId(state.activeSessionId)
  }, [state.activeSessionId])

  useEffect(() => {
    saveActiveProject(state.activeProject)
  }, [state.activeProject])

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  )
}

export function useUiState(): UiState {
  const ctx = useContext(StateCtx)
  if (!ctx) throw new Error('useUiState must be used within AppStateProvider')
  return ctx
}

export function useUiDispatch(): React.Dispatch<UiAction> {
  const ctx = useContext(DispatchCtx)
  if (!ctx) throw new Error('useUiDispatch must be used within AppStateProvider')
  return ctx
}
