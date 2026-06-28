import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import { buildIntentPreview, type IntentPreview, type IntentPreviewAction } from './intent-preview.js'

export type IntentEvalResult = 'continue' | 'veto' | 'alternative'

export interface TurnIntentDeps {
  depositDeadEnd(deposit: { path: string; signal: 'dead-end'; strength: number; context: string; taskId?: string }): Promise<void>
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
  /** Task contract ID for structured dead-end matching (P2). */
  taskContractId?: string
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

    const recentTargets = input.recentToolHistory
      .map(h => h.target)
      .filter((target): target is string => Boolean(target))
    const preview = buildIntentPreview({
      strategy: input.strategy,
      vigor: input.vigor,
      sensorium: input.sensorium,
      pheromones: input.pheromones,
      thrashingSuggestion: input.pressureResult.suggestion ?? null,
      recentTargets,
      taskContractId: input.taskContractId,
    })
    if (!preview) return 'continue'

    this.shown++
    const action = await input.onIntentPreview(preview)

    if (action === 'veto') {
      // 沉积 dead-end 标记，供未来同目标任务关联预警。
      // path 存【原始 target】而非 preview.summary 摘要：摘要带「处理 」前缀且会截断，
      // 让匹配层必须依赖文案常量；存原始 target（文件路径/命令）即可直接与未来
      // recentTargets 子串比对，绕开文案耦合（开源项目文案可能本地化）。
      // 无具体目标（全为 `<...` 伪目标或空）时不沉积——没有可复用的死路标记，
      // 避免产生「继续执行当前计划」这类永不匹配的永久噪声 dead-end。
      const firstTarget = recentTargets.find(t => t && !t.startsWith('<'))
      if (firstTarget) {
        await this.deps.depositDeadEnd({
          path: firstTarget,
          signal: 'dead-end',
          strength: 0.9,
          context: 'intent veto',
          taskId: input.taskContractId,
        })
      }
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
