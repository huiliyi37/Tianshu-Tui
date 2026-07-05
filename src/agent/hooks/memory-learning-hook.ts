import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import { persistExtractedObservations } from '../../memory/observation-extractor.js'
import { processObservationForRuleGeneration } from '../../memory/rule-generator.js'

export interface MemoryLearningHookDeps {
  cwd: string
  sessionId?: string
  getUserMessage: () => string | null
  getStreamedText: () => string
  /**
   * Mid-session rules reload：规则文件生成后立刻让**当前会话**吃到。
   * 没有它，`.rivet/rules/*.md` 只在 bootstrap 装载一次——本会话学到的规则
   * 要等下次启动才生效。propose 按 claim id 幂等，重复 reload 安全。
   */
  onRuleGenerated?: (rulePath: string) => void
}

export function createMemoryLearningPostTurnHook(deps: MemoryLearningHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'memory-learning',
    run() {
      const text = deps.getStreamedText()
      if (!text || text.length < 80) return

      const saved = persistExtractedObservations(deps.cwd, text, deps.sessionId)
      for (const obs of saved) {
        const rulePath = processObservationForRuleGeneration(deps.cwd, obs.text)
        if (rulePath) deps.onRuleGenerated?.(rulePath)
      }
    },
  }
}
