import type { PostTurnRuntimeHook, PreTurnRuntimeHook } from '../runtime-hooks.js'
import { persistExtractedObservations } from '../../memory/observation-extractor.js'
import { processObservationForRuleGeneration } from '../../memory/rule-generator.js'

export interface MemoryLearningHookDeps {
  cwd: string
  sessionId?: string
  getUserMessage: () => string | null
  getStreamedText: () => string
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
        processObservationForRuleGeneration(deps.cwd, obs.text)
      }
    },
  }
}

export function createMemoryLearningPreTurnHook(deps: MemoryLearningHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'memory-learning-prep',
    run() {
      // preTurn side effects handled in loop via promptEngine.setContextAdvisoryBlocks
      void deps.getUserMessage
    },
  }
}
