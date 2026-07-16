/**
 * Advisory-Readback Hook — advisory 采纳核销的运行时接线（P1a）。
 *
 * 双半边设计：
 *   postTool 半边 — 把每个工具事件（完整 target/command + 错误状态）喂进
 *     AdvisoryReadback 的观察日志。不走 recentToolHistory：那是截断的滚动窗口
 *     （重轮次 20+ 调用会把窗口内证据挤掉），也不带 turn 标记。
 *   postTurn 半边 — 对到期的 expect 谓词核销，判定 adopted/ignored，
 *     并把判定事件落遥测（kind: 'advisory-outcome'）。
 *
 * 送达跟踪（track）不在 hook 里：render 发生在 buildTurnRequest（turn-step-producer），
 * hook 管线拿不到那个时点——由 turn-step-producer 在 render 后直接调用。
 */

import type { PostToolRuntimeHook, PostTurnRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryReadback } from '../advisory-readback.js'

export interface AdvisoryReadbackHookDeps {
  readback: AdvisoryReadback
  /** 遥测落盘 — 缺省不写（测试环境） */
  writeTelemetry?: (record: { kind: string } & Record<string, unknown>) => void
  /** 会话累计采纳/忽略变化时回调（guardian meta 摘要接线） */
  onOutcomes?: (totals: { adopted: number; ignored: number }) => void
}

/** 从工具事件中提取核销评估用的 target 字符串（bash → command,写读类 → file_path） */
export function extractObservedTarget(tool: RuntimeToolEvent): string {
  const input = tool.input
  if (input) {
    const cmd = input.command
    if (typeof cmd === 'string') return cmd
    const fp = input.file_path ?? input.path ?? input.file
    if (typeof fp === 'string') return fp
    const pattern = input.pattern
    if (typeof pattern === 'string') return pattern
    // CVM-vector v3.1：recall_capsule 的结构化 input 只有 star 字段——
    // 不提取则 observed target 恒为空串，tool_appears+targetIncludes 谓词
    // 永远无法核销（伪 expect）。结构化提取，不做自由文本猜测。
    const star = input.star
    if (typeof star === 'string') return star
  }
  return tool.target ?? ''
}

export function createAdvisoryReadbackHooks(
  deps: AdvisoryReadbackHookDeps,
): [PostToolRuntimeHook, PostTurnRuntimeHook] {
  const observer: PostToolRuntimeHook = {
    phase: 'postTool',
    name: 'advisory-readback-observe',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      deps.readback.observeTool({
        turn: ctx.snapshot.turn,
        name: tool.name,
        target: extractObservedTarget(tool),
        isError: tool.isError ?? !tool.success,
      })
    },
  }

  const evaluator: PostTurnRuntimeHook = {
    phase: 'postTurn',
    name: 'advisory-readback-evaluate',
    run(ctx: RuntimeHookContext): void {
      const decided = deps.readback.evaluate(ctx.snapshot.turn)
      if (decided === 0) return
      const outcomes = deps.readback.drainOutcomes()
      for (const o of outcomes) {
        // shadow 判定单独 kind:'advisory-holdout'——反事实基线与投递组账本分开回放
        deps.writeTelemetry?.({ kind: o.shadow ? 'advisory-holdout' : 'advisory-outcome', ...o })
      }
      deps.onOutcomes?.(deps.readback.getTotals())
    },
  }

  return [observer, evaluator]
}
