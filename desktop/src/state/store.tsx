import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import {
  loadActiveProject,
  loadActiveSessionId,
  loadAttentionSeen,
  loadOpenTabs,
  loadSidebarVisible,
  loadReviewVisible,
  loadTerminalVisible,
  loadToolDensity,
  loadSplitMode,
  saveActiveProject,
  saveActiveSessionId,
  saveAttentionSeen,
  saveOpenTabs,
  saveSidebarVisible,
  saveReviewVisible,
  saveTerminalVisible,
  saveToolDensity,
  saveSplitMode,
  type ToolDensity,
  type SplitMode,
} from '../lib/persist'

// Codex-style surfaces (P3 vocab): workspace = Project→Thread→Review,
// automations (was schedule), attention (was inbox), settings, git.
export type Surface = 'workspace' | 'mission' | 'automations' | 'attention' | 'settings' | 'skills' | 'git' | 'insights' | 'delegation' | 'council' | 'hooks'

export interface UiState {
  activeSessionId: string | null
  activeProject: string | null // project cwd
  surface: Surface
  newSessionOpen: boolean
  error: string | null
  attentionSeen: string[] // seen attention signatures (Q2)
  toolDensity: ToolDensity
  sidebarVisible: boolean
  reviewVisible: boolean
  terminalVisible: boolean
  /** Zen mode: hides sidebar + review panel for distraction-free focus (Cmd+.). */
  zenMode: boolean
  openTabs: string[]
  /** Split editor mode — reserved for Phase 3, persisted now so it survives reload. */
  splitMode: SplitMode
  /** True when the user explicitly toggled review panel open (Cmd+Shift+B).
   *  Resets when the workspace width recovers above the responsive threshold. */
  reviewManuallyToggled: boolean
  newSessionPrompt: string | null
}

type UiAction =
  | { type: 'setActive'; id: string | null }
  | { type: 'setProject'; projectId: string | null }
  | { type: 'setSurface'; surface: Surface }
  | { type: 'openNew'; open: boolean; prompt?: string }
  | { type: 'setError'; error: string | null }
  | { type: 'markSeen'; sigs: string[] }
  | { type: 'setToolDensity'; density: ToolDensity }
  | { type: 'setSidebar'; visible: boolean }
  | { type: 'setReview'; visible: boolean }
  | { type: 'setTerminal'; visible: boolean }
  | { type: 'closeTab'; id: string }
  | { type: 'reorderTabs'; from: number; to: number }
  | { type: 'toggleZen' }
  | { type: 'setSplitMode'; mode: SplitMode }
  | { type: 'setReviewManual'; on: boolean }

function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'setActive': {
      const tabs = action.id
        ? [action.id, ...state.openTabs.filter((t) => t !== action.id)].slice(0, 10)
        : state.openTabs
      return { ...state, activeSessionId: action.id, openTabs: tabs }
    }
    case 'setProject':
      // Switching project drops the active thread; it belongs to another project.
      return { ...state, activeProject: action.projectId, activeSessionId: null }
    case 'setSurface':
      return { ...state, surface: action.surface }
    case 'openNew':
      return { ...state, newSessionOpen: action.open, newSessionPrompt: action.prompt ?? null }
    case 'setError':
      return { ...state, error: action.error }
    case 'markSeen': {
      if (action.sigs.length === 0) return state
      const merged = new Set([...state.attentionSeen, ...action.sigs])
      // Cap in-memory list to match the persisted cap and prevent unbounded growth.
      return { ...state, attentionSeen: [...merged].slice(-500) }
    }
    case 'setToolDensity':
      return { ...state, toolDensity: action.density }
    case 'setSidebar':
      return { ...state, sidebarVisible: action.visible }
    case 'setReview':
      return { ...state, reviewVisible: action.visible }
    case 'toggleZen': {
      const next = !state.zenMode
      return {
        ...state,
        zenMode: next,
        // Entering zen: hide sidebar + review. Exiting: restore both.
        sidebarVisible: next ? false : true,
        reviewVisible: next ? false : true,
      }
    }
    case 'setTerminal':
      return { ...state, terminalVisible: action.visible }
    case 'closeTab': {
      const tabs = state.openTabs.filter((t) => t !== action.id)
      const activeId = state.activeSessionId === action.id
        ? (tabs[0] ?? null)
        : state.activeSessionId
      return { ...state, openTabs: tabs, activeSessionId: activeId }
    }
    case 'reorderTabs': {
      const tabs = [...state.openTabs]
      if (action.from < 0 || action.to < 0 || action.from >= tabs.length) return state
      const [moved] = tabs.splice(action.from, 1)
      if (!moved) return state
      tabs.splice(Math.min(action.to, tabs.length), 0, moved)
      return { ...state, openTabs: tabs }
    }
    case 'setSplitMode':
      return { ...state, splitMode: action.mode }
    case 'setReviewManual':
      return { ...state, reviewManuallyToggled: action.on }
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
    newSessionPrompt: null,
    error: null,
    attentionSeen: loadAttentionSeen(),
    toolDensity: loadToolDensity(),
    sidebarVisible: loadSidebarVisible(),
    reviewVisible: loadReviewVisible(),
    terminalVisible: loadTerminalVisible(),
    zenMode: false,
    openTabs: loadOpenTabs(),
    splitMode: loadSplitMode(),
    reviewManuallyToggled: false,
  }))

  useEffect(() => {
    saveActiveSessionId(state.activeSessionId)
  }, [state.activeSessionId])

  useEffect(() => {
    saveActiveProject(state.activeProject)
  }, [state.activeProject])

  useEffect(() => {
    saveAttentionSeen(state.attentionSeen)
  }, [state.attentionSeen])

  useEffect(() => {
    saveToolDensity(state.toolDensity)
  }, [state.toolDensity])

  useEffect(() => {
    saveSidebarVisible(state.sidebarVisible)
  }, [state.sidebarVisible])

  useEffect(() => {
    saveReviewVisible(state.reviewVisible)
  }, [state.reviewVisible])

  useEffect(() => {
    saveTerminalVisible(state.terminalVisible)
  }, [state.terminalVisible])

  useEffect(() => {
    saveOpenTabs(state.openTabs)
  }, [state.openTabs])

  useEffect(() => {
    saveSplitMode(state.splitMode)
  }, [state.splitMode])

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
