import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import { buildIntentPreview, type IntentPreview, type IntentPreviewAction } from './intent-preview.js'

export type IntentEvalResult = 'continue' | 'veto' | 'alternative'

export interface TurnIntentDeps {
  depositDeadEnd(deposit: { path: string; signal: 'dead-end'; strength: number; context: string }): Promise<void>
  addUserMessage(message: string): void
}

export interface IntentEvalInput {
  strategy: StrategyProfile
  vigor: VigorState
  sensorium: Sensorium
  pheromones: Pheromone[]
  pressureResult: PressureResult
  recentToolHistory: ToolHistoryEntry[]
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
}

const MAX_INTENT_PREVIEWS = 3

export class TurnIntentController {
  private shown = 0

  constructor(private deps: TurnIntentDeps) {}

  async evaluate(input: IntentEvalInput): Promise<IntentEvalResult> {
    if (!input.onIntentPreview || this.shown >= MAX_INTENT_PREVIEWS) {
      return 'continue'
    }

    // vigor < 0.3 时自动适应，不弹确认框
    // 策略已在 vigor-hook 中自动调整（提高 reasoning effort、commit threshold 等）
    if (input.vigor && input.vigor.vigor < 0.3) {
      return 'continue'
    }

    const preview = buildIntentPreview({
      strategy: input.strategy,
      vigor: input.vigor,
      sensorium: input.sensorium,
      pheromones: input.pheromones,
      thrashingSuggestion: input.pressureResult.suggestion ?? null,
      recentTargets: input.recentToolHistory
        .map(h => h.target)
        .filter((target): target is string => Boolean(target)),
    })
    if (!preview) return 'continue'

    this.shown++
    const action = await input.onIntentPreview(preview)

    if (action === 'veto') {
      await this.deps.depositDeadEnd({
        path: preview.summary,
        signal: 'dead-end',
        strength: 0.9,
        context: 'intent veto',
      })
      this.deps.addUserMessage('<intent-veto>User vetoed the previous plan. Re-plan from the nearest safe branch point before using tools.</intent-veto>')
      return 'veto'
    }

    if (action === 'alternative') {
      this.deps.addUserMessage('<intent-alternative>User requested an alternative path. Prefer a lower-risk option and explain the tradeoff before using tools.</intent-alternative>')
      return 'alternative'
    }

    return 'continue'
  }

  reset(): void {
    this.shown = 0
  }

  getShownCount(): number {
    return this.shown
  }
}
