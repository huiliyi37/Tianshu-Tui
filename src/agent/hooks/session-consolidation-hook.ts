/**
 * 会话结束巩固 hook（postSession）：会话末让模型生成整体摘要 + 可复用做法，
 * 写回长期记忆。与 auto-capture（操作后即时捕获）互补，都是形成侧。
 */

import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import {
  buildConsolidationPrompt, parseConsolidationOutput, applyConsolidation, consolidationEnabled,
  type ConsolidationInput,
} from '../../memory/session-consolidation.js'
import { pruneMemoryStore } from '../../memory/unified-memory.js'

export interface SessionConsolidationHookDeps {
  cwd: string
  sessionId?: string
  /** 会话转录（user + assistant，截断后）。 */
  getTranscript: () => string
  /** 会话目标（objective）。 */
  getObjective?: () => string | null
  /** 侧路 LLM 调用（廉价路由）。 */
  complete: (prompt: string, timeoutMs: number) => Promise<string>
  timeoutMs?: number
}

export function createSessionConsolidationHook(deps: SessionConsolidationHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'session-consolidation',
    async run() {
      // 会话末维护：退役早已封口的历史条目（独立于 LLM，zero 依赖成本）。
      try { pruneMemoryStore(deps.cwd) } catch { /* 维护是尽力而为 */ }
      if (!consolidationEnabled()) return
      const transcript = deps.getTranscript()
      if (transcript.trim().length < 200) return // 过短会话不巩固
      const input: ConsolidationInput = {
        sessionId: deps.sessionId,
        transcript,
        objective: deps.getObjective?.() ?? null,
      }
      const prompt = buildConsolidationPrompt(input)
      let raw: string
      try {
        raw = await deps.complete(prompt, deps.timeoutMs ?? 15_000)
      } catch {
        return // fail-closed
      }
      const output = parseConsolidationOutput(raw)
      if (!output) return // fail-closed
      applyConsolidation(deps.cwd, deps.sessionId, output)
    },
  }
}
