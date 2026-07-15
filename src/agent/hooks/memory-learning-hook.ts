import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import { extractObservations } from '../../memory/observation-extractor.js'
import type { Observation } from '../../memory/observation-store.js'

/** Candidate observation extracted mid-session, buffered for the postSession essence-gate. */
export type ObservationCandidate = Omit<Observation, 'id' | 'ts'>

export interface MemoryLearningHookDeps {
  cwd: string
  sessionId?: string
  getUserMessage: () => string | null
  getStreamedText: () => string
  /**
   * Wave 1（知识重构）：正则提取结果不再直写存储、不再自动生成规则。
   * 候选观察进入内存缓冲，由 postSession essence-gate（LLM 准入闸）统一裁决。
   * 无消费者时提取结果直接丢弃——宁缺毋滥。
   */
  onObservationCandidates?: (candidates: ObservationCandidate[]) => void
  /**
   * @deprecated Wave 1 起不再触发——自动规则生成已停用（曾产出互相矛盾的
   * auto-*.md 规则）。保留字段避免破坏装配方签名。
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

      const extracted = extractObservations(text, deps.sessionId)
      if (extracted.length === 0) return
      deps.onObservationCandidates?.(extracted)
    },
  }
}
