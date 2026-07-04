/**
 * Intent Anchor Hook — preTurn 长 run 意图重锚(主控工作流缺口 C,2026-07-04)。
 *
 * 长自治 run(几十轮无用户输入)里,模型的注意力被最近的工具输出占据,
 * run 的启动意图退化成上下文远端的一段旧文本——出现"局部正确、全局跑偏"。
 *
 * 前提修正(核查):initialUserMessage 每次 run 重置(turn-step-producer),
 * 所以锚点语义是"**本次 run** 的启动意图",不是会话首条消息。意图源复合:
 * taskContract?.objective ?? initialUserMessage(照 loop-factory getObjective
 * 先例),截 500 字。
 *
 * 无行为签名(重读意图不产生可观察工具调用)→ 无 expect 谓词,只计送达。
 * informational tier 受阶段抑制可推迟 ≤2 周期,可接受——意图重锚不急于
 * 特定一轮。
 */

import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface IntentAnchorHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 当前 run 的 orchestrator 循环轮数(每 run 从 0 重计) */
  getRunTurn: () => number
  /** 最近一次用户输入(run 启动或 steer 注入)时的 run 轮数 */
  getLastUserInputTurn: () => number
  /** 复合意图源:taskContract?.objective ?? initialUserMessage,截 500 字 */
  getObjective: () => string | null
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 触发后冷却轮数 */
const COOLDOWN_TURNS = 10

export function createIntentAnchorHook(deps: IntentAnchorHookDeps): PreTurnRuntimeHook {
  let lastFiredRunTurn = -1

  return {
    phase: 'preTurn',
    name: 'intent-anchor',
    run(_ctx: RuntimeHookContext): void {
      const runTurn = deps.getRunTurn()
      // 新 run 开始(轮数回卷)→ 冷却清零
      if (lastFiredRunTurn >= 0 && runTurn < lastFiredRunTurn) lastFiredRunTurn = -1

      const minTurns = envInt('RIVET_INTENT_ANCHOR_TURNS', 20)
      const staleTurns = envInt('RIVET_INTENT_ANCHOR_STALE', 10)

      if (runTurn <= minTurns) return
      if (runTurn - deps.getLastUserInputTurn() <= staleTurns) return
      if (lastFiredRunTurn >= 0 && runTurn - lastFiredRunTurn < COOLDOWN_TURNS) return

      const objective = deps.getObjective()?.trim()
      if (!objective) return

      lastFiredRunTurn = runTurn
      deps.advisoryBus.submit({
        key: 'intent-anchor',
        priority: 0.45,
        category: 'discipline',
        tier: 'informational',
        content: `已连续自治运行 ${runTurn} 轮。本次 run 的启动意图是:「${objective.slice(0, 500)}」——对照当前工作,确认没有偏离主线;若已偏离,收束支线回到主目标。`,
        ttl: 2,
        // 无行为签名(重读意图不产生可观察调用)→ 不带 expect,只计送达
      })
    },
  }
}
