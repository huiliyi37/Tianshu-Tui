/**
 * Batch Convergence Hook — postTool 检测批量并行工具调用过载。
 *
 * 当单 turn 累计工具调用数 ≥5 时，通过 advisory bus 提交收敛提醒，
 * 引导 agent 在汇总批量结果前完成分层收敛（分类→交叉验证→综合判断）。
 * 同一 turn 最多触发一次，turn 切换时计数器自动清零。
 *
 * 触发阈值 5 是基于 empirical 观察：当并行只读调用 ≥5 时，agent 在
 * 汇总阶段出错的概率显著上升（glob 结果混淆、跨桶比较等）。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface BatchConvergenceHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** 触发阈值：单 turn 工具调用数达到此值时触发提醒 */
const BATCH_THRESHOLD = 5

/** 收敛提醒文本 */
const CONVERGENCE_MESSAGE =
  '本 turn 已收到 ≥5 个并行工具结果。在综合下结论前，请先完成三层收敛：' +
  '① 按类型分桶（存在性/内容/搜索），不跨桶比较；' +
  '② 关键断言至少一条独立交叉验证，单来源 = 待验证假设；' +
  '③ 前两步完成后才能给结论。'

export function createBatchConvergenceHook(deps: BatchConvergenceHookDeps): PostToolRuntimeHook {
  let toolCount = 0
  let lastTurn = -1
  let firedThisTurn = false

  return {
    phase: 'postTool',
    name: 'batch-convergence',
    run(_ctx: RuntimeHookContext, _tool: RuntimeToolEvent) {
      const currentTurn = _ctx.snapshot.turn

      // turn 切换 → 重置计数器
      if (currentTurn !== lastTurn) {
        toolCount = 0
        firedThisTurn = false
        lastTurn = currentTurn
      }

      toolCount++

      if (toolCount >= BATCH_THRESHOLD && !firedThisTurn) {
        firedThisTurn = true
        deps.advisoryBus.submit({
          key: 'batch-convergence',
          priority: 0.55,
          category: 'discipline',
          tier: 'operational',
          content: CONVERGENCE_MESSAGE,
          ttl: 1,
        })
      }
    },
  }
}
