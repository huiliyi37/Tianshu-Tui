import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { CognitiveSeason } from './cognitive-season.js'
import type { FailureClass } from './failure-classifier.js'
import type { Sensorium, SensoriumInput, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { DecisionShift } from './loop-types.js'

export type RuntimeHookPhase = 'preTurn' | 'afterPerception' | 'postTool' | 'postTurn' | 'postSession'

export interface RuntimeToolEvent {
  name: string
  success: boolean
  target?: string
  /** Original structured ToolUse input. Hooks that need file semantics must
   *  prefer this over target because target is a display/history fallback. */
  input?: Record<string, unknown>
  isError?: boolean
  /** Failure classification from failure-classifier.ts — enables vigor to distinguish
   *  semantic failures (type_error, assertion) from environment issues (timeout, api_error). */
  failureClass?: FailureClass
  /** Tool result content string — enables hooks to inspect output for lossy markers
   *  and other content-level signals without duplicating tool-pipeline logic. */
  resultContent?: string
}

export interface RuntimeHookSnapshot {
  cwd: string
  turn: number
  recentToolHistory: Array<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash'>>
  sensorium: Sensorium | null
  sensoriumInput?: SensoriumInput
  providerDegradationRatio?: number
  strategy: StrategyProfile | null
  vigor: VigorState | null
  gitChangeRate: number
  season: CognitiveSeason | null
  /** Theta telemetry for elm-micro-release timeout suppression. */
  thetaTelemetry?: {
    lastTimedOut: boolean
    consecutiveTimeouts: number
  }
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session.
   *  Task-level, not windowed — survives a long turn where the edit scrolled out
   *  of recentToolHistory. */
  touchedTsFiles?: boolean
  /** Component C: a real typecheck has run since the last TS edit. */
  sawTypecheckThisTask?: boolean
}

export interface RuntimePhaseChangeDetail {
  tool?: string
  reason?: string
  suggestion?: string
}

export interface RuntimeHookEffects {
  setSensorium(sensorium: Sensorium): void
  setStrategy(strategy: StrategyProfile): void
  setVigor(vigor: VigorState): void
  setGitChangeRate(rate: number): void
  injectUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  emitPhaseChange(phase: string, detail?: RuntimePhaseChangeDetail): void
  /** R4 — surface a structured course-correction to the desktop conversation. */
  emitDecisionShift(shift: DecisionShift): void
  markClaimStale(claimId: string): void
}

export interface RuntimeHookContext {
  snapshot: RuntimeHookSnapshot
  effects: RuntimeHookEffects
}

export interface PreTurnRuntimeHook {
  phase: 'preTurn'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface AfterPerceptionRuntimeHook {
  phase: 'afterPerception'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostToolRuntimeHook {
  phase: 'postTool'
  name: string
  run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> | void
}

export interface PostTurnRuntimeHook {
  phase: 'postTurn'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostSessionRuntimeHook {
  phase: 'postSession'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export type RuntimeHook =
  | PreTurnRuntimeHook
  | AfterPerceptionRuntimeHook
  | PostToolRuntimeHook
  | PostTurnRuntimeHook
  | PostSessionRuntimeHook

export interface RuntimeHookError {
  phase: RuntimeHookPhase
  hookName: string
  message: string
  error: unknown
}

export interface RuntimeHookPipelineOptions {
  onError?: (error: RuntimeHookError) => void
}

function noop(): void {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRuntimeHookContext(
  snapshot: RuntimeHookSnapshot,
  effects: Partial<RuntimeHookEffects> = {},
): RuntimeHookContext {
  return {
    snapshot,
    effects: {
      setSensorium: sensorium => {
        snapshot.sensorium = sensorium
        effects.setSensorium?.(sensorium)
      },
      setStrategy: strategy => {
        snapshot.strategy = strategy
        effects.setStrategy?.(strategy)
      },
      setVigor: vigor => {
        snapshot.vigor = vigor
        effects.setVigor?.(vigor)
      },
      setGitChangeRate: rate => {
        snapshot.gitChangeRate = rate
        effects.setGitChangeRate?.(rate)
      },
      injectUserMessage: effects.injectUserMessage ?? noop,
      requestThetaCheck: effects.requestThetaCheck ?? noop,
      emitPhaseChange: effects.emitPhaseChange ?? noop,
      emitDecisionShift: effects.emitDecisionShift ?? noop,
      markClaimStale: effects.markClaimStale ?? noop,
    },
  }
}

export class RuntimeHookPipeline {
  private preTurnHooks: PreTurnRuntimeHook[] = []
  private afterPerceptionHooks: AfterPerceptionRuntimeHook[] = []
  private postToolHooks: PostToolRuntimeHook[] = []
  private postTurnHooks: PostTurnRuntimeHook[] = []
  private postSessionHooks: PostSessionRuntimeHook[] = []

  constructor(
    hooks: RuntimeHook[] = [],
    private options: RuntimeHookPipelineOptions = {},
  ) {
    for (const hook of hooks) this.register(hook)
  }

  register(hook: RuntimeHook): void {
    switch (hook.phase) {
      case 'preTurn':
        this.preTurnHooks.push(hook)
        break
      case 'afterPerception':
        this.afterPerceptionHooks.push(hook)
        break
      case 'postTool':
        this.postToolHooks.push(hook)
        break
      case 'postTurn':
        this.postTurnHooks.push(hook)
        break
      case 'postSession':
        this.postSessionHooks.push(hook)
        break
    }
  }

  async runPreTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('preTurn', this.preTurnHooks, hook => hook.run(ctx))
  }

  async runAfterPerception(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('afterPerception', this.afterPerceptionHooks, hook => hook.run(ctx))
  }

  async runPostTool(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> {
    await this.runPhase('postTool', this.postToolHooks, hook => hook.run(ctx, tool))
  }

  async runPostTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postTurn', this.postTurnHooks, hook => hook.run(ctx))
  }

  async runPostSession(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postSession', this.postSessionHooks, hook => hook.run(ctx))
  }

  private async runPhase<T extends RuntimeHook>(
    phase: RuntimeHookPhase,
    hooks: T[],
    invoke: (hook: T) => Promise<void> | void,
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await invoke(hook)
      } catch (error) {
        this.options.onError?.({
          phase,
          hookName: hook.name,
          message: toMessage(error),
          error,
        })
      }
    }
  }
}
