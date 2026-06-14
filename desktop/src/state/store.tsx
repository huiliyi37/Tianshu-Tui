import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import { loadActiveSessionId, saveActiveSessionId } from '../lib/persist'

export type Surface = 'workspace' | 'inbox' | 'schedule'

export interface UiState {
  activeSessionId: string | null
  surface: Surface
  newSessionOpen: boolean
  error: string | null
}

type UiAction =
  | { type: 'setActive'; id: string | null }
  | { type: 'setSurface'; surface: Surface }
  | { type: 'openNew'; open: boolean }
  | { type: 'setError'; error: string | null }

function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'setActive':
      return { ...state, activeSessionId: action.id }
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
    surface: 'workspace' as Surface,
    newSessionOpen: false,
    error: null,
  }))

  useEffect(() => {
    saveActiveSessionId(state.activeSessionId)
  }, [state.activeSessionId])

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
