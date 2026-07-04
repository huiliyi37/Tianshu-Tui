/**
 * Turn Budget Hook — preTurn maxTurns 预算预警(主控工作流缺口 D,2026-07-04)。
 *
 * maxTurns 耗尽是 GUARD-forced stop(turn-orchestrator):run 在任务中途
 * 被硬切,已完成但未验证/未落盘的工作直接蒸发。模型自身看不到预算——
 * 它不知道自己还剩几轮。本 hook 在剩余轮数进入危险区时预警一次,
 * 引导模型收敛:优先交付已验证部分、落 checkpoint,而不是开新支线。
 *
 * 出生即可测(因果账本):expect = verify_attempted(2 轮)——采纳 =
 * 收到预警后先验证手头工作(收敛信号),自动进 holdout lift 与跨会话
 * 效能信息素。
 */

import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface TurnBudgetHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  getMaxTurns: () => number
  /** 当前 run 的 orchestrator 循环轮数(每 run 从 0 重计) */
  getRunTurn: () => number
}

export function createTurnBudgetHook(deps: TurnBudgetHookDeps): PreTurnRuntimeHook {
  let firedAtRunTurn = -1

  return {
    phase: 'preTurn',
    name: 'turn-budget',
    run(_ctx: RuntimeHookContext): void {
      const runTurn = deps.getRunTurn()
      // 新 run(轮数回卷)→ 重新武装
      if (firedAtRunTurn >= 0 && runTurn < firedAtRunTurn) firedAtRunTurn = -1
      if (firedAtRunTurn >= 0) return // 每 run 只触发一次

      const maxTurns = deps.getMaxTurns()
      if (maxTurns <= 0) return

      const remaining = maxTurns - runTurn
      const threshold = Math.max(3, Math.ceil(maxTurns * 0.1))
      if (remaining > threshold) return

      firedAtRunTurn = runTurn
      deps.advisoryBus.submit({
        key: 'turn-budget',
        priority: 0.7,
        category: 'discipline',
        tier: 'operational',
        content: `轮数预算即将耗尽:还剩 ${remaining} 轮(maxTurns=${maxTurns})之后 run 被强制截断。现在收敛:优先验证并交付已完成的部分、把未竟工作落 checkpoint/文档,不要开新支线。`,
        ttl: 2,
        // 采纳 = 预警后 2 轮内出现验证动作(收敛而非继续铺开)
        expect: { kind: 'verify_attempted', withinTurns: 2 },
        channel: 'system-reminder',
      })
    },
  }
}
