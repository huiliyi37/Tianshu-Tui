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
 *   reversal — 全静默（v1 保守：设计写"只保留智/义"，实现为全静默）
 *   return — 静默（复归窗口少打扰）
 *   wuwei — 全静默（成熟会话不需要糖果）
 *
 * 不进 AdvisoryReadback 的 adopted/ignored 账本——美德信号不是 advisory。
 */

import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryReadback } from '../advisory-readback.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { VirtuePendingLedger, VirtueSignal } from '../virtue-signals.js'
import { computeVirtueWeights } from '../virtue-signals.js'
import type { VirtueWeightResult } from '../virtue-signals.js'
import { virtueEncouragementEntry } from '../advisory-bus.js'
import type { CognitiveSeason } from '../cognitive-season.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import { detectEvidenceGate } from '../evidence-gate.js'

/** 效用转正阈值——低于此值的美德信号不记录（走过场） */
const UTILITY_THRESHOLD = 0.5

/** 信触发条件 */
const XIN_MIN_TURN = 5
const XIN_MIN_HIT_RATE = 0.8
const XIN_COOLDOWN_TURNS = 10

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

export function createVirtueSettlementHook(
  deps: VirtueSettlementHookDeps,
): PostTurnRuntimeHook {
  let xinLastTriggered = 0 // 信上次触发的 turn（0 = 未触发过）

  const evaluator: PostTurnRuntimeHook = {
    phase: 'postTurn',
    name: 'virtue-settlement-evaluate',
    async run(ctx: RuntimeHookContext): Promise<void> {
      const currentTurn = ctx.snapshot.turn
      const season = deps.getSeason()
      const intensity = deps.getSeasonIntensity()

      // ── T3 证据门：用 readback events（非 recentToolHistory）做数据源 ──
      // readback 按轮保留 8 轮，不受 5 条滚动窗口截断限制（T3 预警）。
      const evidenceWindow = 6 // evidence-gate 默认窗口
      const evidenceEvents = deps.readback.getRecentToolEvents(currentTurn - evidenceWindow)
      const evidenceState = detectEvidenceGate({
        recentHistory: evidenceEvents,
        currentTurn,
        windowTurns: evidenceWindow,
      })

      // ── T3 预计算权重缓存 ──
      const weightCache = new Map<string, VirtueWeightResult>()
      const getWeights = (type: string) => {
        let w = weightCache.get(type)
        if (!w) {
          w = computeVirtueWeights(type as VirtueSignal['type'], season, intensity, evidenceState.active)
          weightCache.set(type, w)
        }
        return w
      }

      // ── 信号复活（T0）：实测缓存命中率 ≥ 80% 且 turn ≥ 5 → 触发一次 ──
      // 会话级信号不走 pending ledger——每 10 轮最多触发一次，防刷分。
      if (!xinLastTriggered || currentTurn - xinLastTriggered >= XIN_COOLDOWN_TURNS) {
        const hitRate = deps.getRecentCacheHitRate()
        if (hitRate !== null && hitRate >= XIN_MIN_HIT_RATE && currentTurn >= XIN_MIN_TURN) {
          const xinSignal: VirtueSignal = {
            type: 'cache-loyalty',
            confidence: 0.9,
            wuchang: '信',
            evidence: '模型保护了前缀缓存的连续性——信者，天枢之本也',
          }
          const xinWeights = getWeights('cache-loyalty')
          deps.recordStance(xinSignal)
          deps.deposit({
            path: 'virtue-signal',
            signal: 'cache-loyalty',
            strength: xinSignal.confidence * xinWeights.weight,
            context: xinSignal.evidence,
            halfLifeMs: 604_800_000 * 2,
          }).catch(() => {})
          if (xinWeights.encouragementAllowed) {
            deps.advisoryBus.submit(virtueEncouragementEntry())
          }
          xinLastTriggered = currentTurn
        }
      }

      const settled = deps.ledger.drainSettled(currentTurn)
      if (settled.length === 0) return

      for (const entry of settled) {
        // 智的自持逻辑（方案C）：用 readback 负向查询——同 tool+target 在检测后
        // 再次出现 = 原地重复 = 低效用；未再出现 = 转向 = 高效用。
        // detectedTurn+1 起窗避免把触发检测的那次调用自己算进去。
        if (entry.signal.type === 'strategic-awareness' && entry.probeTool) {
          const reappeared = deps.readback.wasSatisfiedBetween(
            { kind: 'tool_appears', tools: [entry.probeTool], targetIncludes: entry.probeTarget },
            entry.detectedTurn + 1,
            currentTurn,
          )
          const utility = reappeared ? 0.2 : 1.0
          if (utility < UTILITY_THRESHOLD) continue
          const zhiWeights = getWeights('strategic-awareness')
          deps.recordStance(entry.signal)
          deps.deposit({
            path: 'virtue-signal',
            signal: entry.signal.type,
            strength: entry.signal.confidence * utility * zhiWeights.weight,
            context: entry.signal.evidence,
            halfLifeMs: 604_800_000 * 2,
          }).catch(() => {})
          if (zhiWeights.encouragementAllowed) {
            deps.advisoryBus.submit(virtueEncouragementEntry())
          }
          continue
        }

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
        const vWeights = getWeights(entry.signal.type)
        deps.recordStance(entry.signal)

        // deposit pheromone（美德信息素，半衰期 14 天）
        deps.deposit({
          path: 'virtue-signal',
          signal: entry.signal.type,
          strength: entry.signal.confidence * utility * vWeights.weight,
          context: entry.signal.evidence,
          halfLifeMs: 604_800_000 * 2,
        }).catch(() => { /* best-effort */ })

        // 季节鼓励门
        if (vWeights.encouragementAllowed) {
          deps.advisoryBus.submit(virtueEncouragementEntry())
        }
      }
    },
  }

  return evaluator
}
