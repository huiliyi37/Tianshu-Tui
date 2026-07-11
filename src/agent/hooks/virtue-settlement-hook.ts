/**
 * Virtue Settlement Hook — 美德信号两段式核销的运行时接线（T2b）。
 *
 * 双半边设计（照抄 createAdvisoryReadbackHooks 的成对结构）：
 *   postTool 半边 — 将工具事件喂进 AdvisoryReadback 的观察日志，
 *     为后续 utility 谓词检查提供数据源。不参与美德检测（那是 stigmergy-hook 的职责）。
 *   postTurn 半边 — 从 VirtuePendingLedger drainSettled 到期的 pending，
 *     用 readback.wasSatisfiedBetween() 检查效用谓词：
 *       utility ≥ 阈值 → recordStance + deposit pheromone + 季节门允许时 submit 鼓励
 *       utility < 阈值 → 丢弃（走过场的美德不记账）
 *
 * 季节鼓励门（10.1 调制矩阵）：
 *   genesis — 正常送达（习惯形成期正反馈价值最高）
 *   reversal — 静默（压力态下泛泛表扬是噪音）
 *   return — 静默（复归窗口少打扰）
 *   wuwei — 全静默（成熟会话不需要糖果）
 *
 * 不进 AdvisoryReadback 的 adopted/ignored 账本——美德信号不是 advisory。
 */

import type { PostToolRuntimeHook, PostTurnRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryReadback } from '../advisory-readback.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { VirtuePendingLedger, VirtueSignal } from '../virtue-signals.js'
import { virtueEncouragementEntry } from '../advisory-bus.js'
import type { CognitiveSeason } from '../cognitive-season.js'
import { extractObservedTarget } from './advisory-readback-hook.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'

/** 效用转正阈值——低于此值的美德信号不记录（走过场） */
const UTILITY_THRESHOLD = 0.5

/** 季节鼓励门：true = 允许送达鼓励条目 */
const SEASON_ENCOURAGEMENT_ALLOWED: ReadonlySet<CognitiveSeason> = new Set(['genesis'])

export interface VirtueSettlementHookDeps {
  ledger: VirtuePendingLedger
  readback: AdvisoryReadback
  /** 记录转正的美德信号到 stanceTally */
  recordStance: (signal: VirtueSignal) => void
  /** 存款信息素（从 stigmergy-hook 迁来——只有转正的信号才 deposit） */
  deposit: (d: PheromoneDeposit) => Promise<void>
  /** advisory bus——季节门允许时 submit 鼓励 */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 当前季节——从 ctx.snapshot.season 可读，但接口注入更利于测试 */
  getSeason: () => CognitiveSeason
  getSeasonIntensity: () => number
  /** 近 N 轮平均缓存命中率（T0 信复活用），null = 数据不足 */
  getRecentCacheHitRate: () => number | null
}

export function createVirtueSettlementHooks(
  deps: VirtueSettlementHookDeps,
): [PostToolRuntimeHook, PostTurnRuntimeHook] {
  const observer: PostToolRuntimeHook = {
    phase: 'postTool',
    name: 'virtue-settlement-observe',
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
    name: 'virtue-settlement-evaluate',
    async run(ctx: RuntimeHookContext): Promise<void> {
      const currentTurn = ctx.snapshot.turn
      const settled = deps.ledger.drainSettled(currentTurn)
      if (settled.length === 0) return

      const season = deps.getSeason()

      for (const entry of settled) {
        // 效用判定：用 readback 的观察日志查询谓词是否被满足
        let utility = 1.0 // 默认乐观（pattern_absent 等无谓词的场景）
        if (entry.utilityExpect.kind !== 'pattern_absent') {
          const satisfied = deps.readback.wasSatisfiedBetween(
            entry.utilityExpect,
            entry.detectedTurn,
            currentTurn,
          )
          utility = satisfied ? 1.0 : 0.2
        }

        if (utility < UTILITY_THRESHOLD) continue // 走过场的美德不记账

        // 转正：记录 + deposit + 季节门鼓励
        deps.recordStance(entry.signal)

        // deposit pheromone（美德信息素，半衰期 14 天）
        deps.deposit({
          path: 'virtue-signal',
          signal: entry.signal.type,
          strength: entry.signal.confidence * utility,
          context: entry.signal.evidence,
          halfLifeMs: 604_800_000 * 2,
        }).catch(() => { /* best-effort */ })

        // 季节鼓励门
        if (SEASON_ENCOURAGEMENT_ALLOWED.has(season)) {
          deps.advisoryBus.submit(virtueEncouragementEntry())
        }
      }
    },
  }

  return [observer, evaluator]
}
