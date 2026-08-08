/**
 * Essence-gate hook — postSession 知识准入闸的运行时接线。
 *
 * 收口三路素材（正则观察缓冲 / agent 手动 remember 队列 / 失败模式），
 * 一次廉价 LLM 侧路调用统一裁决准入（详见 src/memory/essence-gate.ts）。
 * LLM 不可用时 fail-closed：什么都不写。
 */

import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { FailureJournal } from '../failure-journal.js'
import { runEssenceGate, type KnowledgeCandidate, type EssenceGateResult } from '../../memory/essence-gate.js'
import { writeGateLedgerRow } from '../../memory/gate-ledger.js'

export interface EssenceGateHookDeps {
  cwd: string
  sessionId?: string
  /** 会话级候选缓冲（观察 + 手动 remember 队列）。 */
  getCandidates: () => KnowledgeCandidate[]
  /** 失败素材（salvage 蒸馏输入）。 */
  getFailureJournal?: () => FailureJournal
  /** 侧路 LLM 调用（廉价路由，实现方负责 usage 落账 + 超时）。 */
  complete: (prompt: string, timeoutMs: number) => Promise<string>
  /** 内层 LLM fail-closed 预算。缺省 15s（essence-gate.ts DEFAULT_TIMEOUT_MS）。
   *  必须 < 本 hook 的外层 budgetMs（20s），否则外层先炸产生假超时。 */
  timeoutMs?: number
  /** 裁决结果回调（诊断/遥测用）。 */
  onResult?: (result: EssenceGateResult) => void
}

/** 外层 Runtime Hook 预算（ms）。必须 > 内层 fail-closed（默认 15s）——
 *  内层超时先完成 fail-closed，外层护栏只是兜底，不该抢跑。 */
export const ESSENCE_GATE_HOOK_BUDGET_MS = 20_000

/** 失败模式 → salvage 候选。只送检测出的聚合模式，不送单条失败流水。 */
function failurePatternCandidates(journal: FailureJournal, sessionId?: string): KnowledgeCandidate[] {
  return journal.detectPatterns().map(pattern => ({
    text: `${pattern.type}: ${pattern.suggestion} (observed ${pattern.count}x: ${pattern.evidence.slice(0, 2).map(e => `${e.tool} — ${e.error.slice(0, 80)}`).join('; ')})`,
    kind: 'failure_pattern',
    confidence: 0.6,
    origin: 'failure' as const,
    tags: ['failure-pattern', pattern.type],
    sessionId,
  }))
}

export function createEssenceGateHook(deps: EssenceGateHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'essence-gate',
    budgetMs: ESSENCE_GATE_HOOK_BUDGET_MS,
    async run() {
      const startedAt = Date.now()
      const candidates = [...deps.getCandidates()]
      const journal = deps.getFailureJournal?.()
      if (journal) candidates.push(...failurePatternCandidates(journal, deps.sessionId))

      if (candidates.length === 0) return

      const result = await runEssenceGate(
        { cwd: deps.cwd, sessionId: deps.sessionId, complete: deps.complete, timeoutMs: deps.timeoutMs },
        candidates,
      )
      // 闭环 1（反馈回路）：裁决落账——后续会话经 analyzeGateFeedback 与
      // recall-efficacy join，度量闸门准入标准是否过宽/过严。
      // 兼容字段：候选数 / 耗时 / 失败归因（timeout vs invalid_output vs llm_error），
      // 让「外层假超时」与「内层真实失败」在账本上可区分。
      writeGateLedgerRow(deps.cwd, {
        sessionId: deps.sessionId ?? 'unknown',
        ts: Date.now(),
        admitted: result.admittedRefs,
        rejected: result.rejectedRefs,
        superseded: result.supersededRefs,
        failedClosed: result.failedClosed,
        candidateCount: candidates.length,
        durationMs: Date.now() - startedAt,
        failureReason: result.failureReason,
      })
      deps.onResult?.(result)
    },
  }
}
