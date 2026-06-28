import type {
  PostToolRuntimeHook,
  PostTurnRuntimeHook,
  PreTurnRuntimeHook,
  PostSessionRuntimeHook,
  RuntimeHook,
} from '../runtime-hooks.js'
import { runHooksForEvent, type HookEvent, type HookResult } from '../../hooks/user-hooks-runner.js'

export interface HookResultMeta {
  event: HookEvent
  turn?: number
  toolName?: string
  error?: string
}

export interface UserHooksBridgeDeps {
  cwd: string
  sessionId?: string
  getTurn: () => number
  /** I4: surfaced as `hook_result` events on the desktop event stream. */
  emitHookResult?: (results: HookResult[], meta: HookResultMeta) => void
}

function bridgeHook(deps: UserHooksBridgeDeps, event: HookEvent): RuntimeHook {
  const base = { cwd: deps.cwd, sessionId: deps.sessionId, turn: deps.getTurn() }
  const emit = (results: HookResult[], extra?: Partial<HookResultMeta>) => {
    deps.emitHookResult?.(results, { event, turn: deps.getTurn(), ...extra })
  }

  if (event === 'preTurn') {
    return {
      phase: 'preTurn',
      name: 'user-hooks-preTurn',
      run() {
        emit(runHooksForEvent(deps.cwd, { ...base, event: 'preTurn', turn: deps.getTurn() }))
      },
    } satisfies PreTurnRuntimeHook
  }

  if (event === 'postTurn') {
    return {
      phase: 'postTurn',
      name: 'user-hooks-postTurn',
      run() {
        emit(runHooksForEvent(deps.cwd, { ...base, event: 'postTurn', turn: deps.getTurn() }))
      },
    } satisfies PostTurnRuntimeHook
  }

  if (event === 'postSession') {
    return {
      phase: 'postSession',
      name: 'user-hooks-postSession',
      run() {
        emit(runHooksForEvent(deps.cwd, { ...base, event: 'postSession', turn: deps.getTurn() }))
      },
    } satisfies PostSessionRuntimeHook
  }

  return {
    phase: 'postTool',
    name: 'user-hooks-postTool',
    run(_ctx, tool) {
      emit(
        runHooksForEvent(deps.cwd, {
          ...base,
          event: 'postTool',
          turn: deps.getTurn(),
          toolName: tool.name,
          toolResult: tool.success ? 'success' : 'failure',
        }),
        { toolName: tool.name },
      )
    },
  } satisfies PostToolRuntimeHook
}

/** I4: run user-configured `onError` hooks outside the normal phase pipeline. */
export function runOnErrorHooks(deps: UserHooksBridgeDeps, error: string): void {
  if (!deps.emitHookResult) return
  const results = runHooksForEvent(deps.cwd, {
    cwd: deps.cwd,
    sessionId: deps.sessionId,
    turn: deps.getTurn(),
    event: 'onError',
    error,
  })
  deps.emitHookResult(results, { event: 'onError', turn: deps.getTurn(), error })
}

export function createUserHooksBridge(deps: UserHooksBridgeDeps): RuntimeHook[] {
  return [
    bridgeHook(deps, 'preTurn'),
    bridgeHook(deps, 'postTurn'),
    bridgeHook(deps, 'postTool'),
    bridgeHook(deps, 'postSession'),
  ]
}
