import type {
  PostToolRuntimeHook,
  PostTurnRuntimeHook,
  PreTurnRuntimeHook,
  PostSessionRuntimeHook,
  RuntimeHook,
} from '../runtime-hooks.js'
import { runHooksForEvent, type HookEvent } from '../../hooks/user-hooks-runner.js'

export interface UserHooksBridgeDeps {
  cwd: string
  sessionId?: string
  getTurn: () => number
}

function bridgeHook(deps: UserHooksBridgeDeps, event: HookEvent): RuntimeHook {
  const base = { cwd: deps.cwd, sessionId: deps.sessionId, turn: deps.getTurn() }

  if (event === 'preTurn') {
    return {
      phase: 'preTurn',
      name: 'user-hooks-preTurn',
      run() {
        runHooksForEvent(deps.cwd, { ...base, event: 'preTurn', turn: deps.getTurn() })
      },
    } satisfies PreTurnRuntimeHook
  }

  if (event === 'postTurn') {
    return {
      phase: 'postTurn',
      name: 'user-hooks-postTurn',
      run() {
        runHooksForEvent(deps.cwd, { ...base, event: 'postTurn', turn: deps.getTurn() })
      },
    } satisfies PostTurnRuntimeHook
  }

  if (event === 'postSession') {
    return {
      phase: 'postSession',
      name: 'user-hooks-postSession',
      run() {
        runHooksForEvent(deps.cwd, { ...base, event: 'postSession', turn: deps.getTurn() })
      },
    } satisfies PostSessionRuntimeHook
  }

  return {
    phase: 'postTool',
    name: 'user-hooks-postTool',
    run(_ctx, tool) {
      runHooksForEvent(deps.cwd, {
        ...base,
        event: 'postTool',
        turn: deps.getTurn(),
        toolName: tool.name,
        toolResult: tool.success ? 'success' : 'failure',
      })
    },
  } satisfies PostToolRuntimeHook
}

export function createUserHooksBridge(deps: UserHooksBridgeDeps): RuntimeHook[] {
  return [
    bridgeHook(deps, 'preTurn'),
    bridgeHook(deps, 'postTurn'),
    bridgeHook(deps, 'postTool'),
    bridgeHook(deps, 'postSession'),
  ]
}
