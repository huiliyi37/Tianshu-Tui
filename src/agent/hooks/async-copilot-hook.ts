/**
 * Async-Copilot Hook — 异步副驾情境合成（Phase 3, 2026-07-04 生命周期设计）。
 *
 * 模板类 advisory 只能覆盖预定义场景;副驾用 cheap model 对当前情境做一次
 * navigator 式中层建议合成（指向"方向/取舍",不逐行挑刺）,经 bus star_domain
 * informational 注入下一轮。为主控分担的是"退一步看局面"的元认知,不是代码审查。
 *
 * 纪律（全部可自证,不靠自觉）:
 *   可行性双闸门（运行时数据判定,非离线拍板）:
 *     1. 全局采纳率 > 30%（含最小样本量）——证明主模型确实读 advisory;
 *        低于线说明该先修注入位置/格式,合成更聪明的内容是低 ROI
 *     2. 闸门未过 → hook 静默休眠,不调 LLM 不投递（每会话最多一条遥测记录）
 *   节流:turn % N（缺省 8）或 stall 信号（verifyFailStreak≥2,带独立冷却）
 *   inFlight 守卫（theta 同款）:上一次合成未返回不再发
 *   自我淘汰:copilot-advice 走同一采纳率账本;决出 ≥4 且采纳率 <25% →
 *     间隔翻倍（至多 32）;采纳率 ≥50% → 间隔减半（下限 base）。
 *     账本证明有价值才提频——副驾的存在本身受数据考核。
 *
 * cheap model 输出协议（两行,便于解析 + 让建议可核销）:
 *   ADVICE: <一句中层建议>
 *   EXPECT: verify_attempted | tool_appears:<tool 名> | none
 */

import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus, AdvisoryExpectation } from '../advisory-bus.js'
import type { AdvisoryKeyStats } from '../advisory-readback.js'
import { computeVerifyFailStreak } from './cognitive-capsule-router.js'

export interface CopilotContextPack {
  /** 任务契约目标（无契约 = null） */
  objective: string | null
  /** 当前星域名 */
  starDomain: string | null
}

export interface AsyncCopilotHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 采纳率账本查询（可行性闸门 + 自我淘汰的数据源） */
  readback: {
    getTotals(): { adopted: number; ignored: number }
    getStats(): ReadonlyMap<string, AdvisoryKeyStats>
  }
  /** 任务侧情境（快照之外的部分） */
  getContext: () => CopilotContextPack
  /** cheap model 调用。resolve null = 基础设施不可用 → hook 永久休眠。 */
  complete: (system: string, user: string) => Promise<string | null>
  writeTelemetry?: (record: { kind: string } & Record<string, unknown>) => void
  /** 常规触发间隔（轮）,缺省 8 */
  baseInterval?: number
}

/** 可行性闸门:最小决出样本量（adopted+ignored） */
export const COPILOT_GATE_MIN_DECIDED = 10
/** 可行性闸门:全局采纳率下限 */
export const COPILOT_GATE_MIN_ADOPTION = 0.3
/** 自我淘汰:降频判定的最小自身样本量 */
const SELF_ELIM_MIN_DECIDED = 4
/** 自我淘汰:间隔上限 */
const MAX_INTERVAL = 32
/** stall 触发的独立冷却（轮） */
const STALL_COOLDOWN = 6

const SYSTEM_PROMPT = [
  '你是编码 agent 的副驾（navigator）。基于情境包给出一条中层建议:',
  '指向方向/取舍/被忽略的风险,不逐行挑刺、不复述情境、不超过两句话。',
  '严格按以下两行格式输出,不加任何其他内容:',
  'ADVICE: <建议>',
  'EXPECT: verify_attempted 或 tool_appears:<工具名> 或 none',
  '（EXPECT 是"建议被采纳时下一轮会观察到的行为";没有单一行为签名就写 none）',
].join('\n')

/** 解析 cheap model 的两行协议输出。格式不合规 → null（不投递,不猜）。 */
export function parseCopilotResponse(text: string): { advice: string; expect?: AdvisoryExpectation } | null {
  const adviceMatch = /^ADVICE:\s*(.+)$/m.exec(text)
  if (!adviceMatch) return null
  const advice = adviceMatch[1]!.trim()
  if (advice.length === 0 || advice.length > 400) return null

  const expectMatch = /^EXPECT:\s*(.+)$/m.exec(text)
  const expectRaw = expectMatch?.[1]?.trim() ?? 'none'
  let expect: AdvisoryExpectation | undefined
  if (expectRaw === 'verify_attempted') {
    expect = { kind: 'verify_attempted', withinTurns: 2 }
  } else {
    const toolMatch = /^tool_appears:\s*([\w-]+)$/.exec(expectRaw)
    if (toolMatch) expect = { kind: 'tool_appears', tools: [toolMatch[1]!], withinTurns: 2 }
  }
  return { advice, expect }
}

export function createAsyncCopilotHook(
  deps: AsyncCopilotHookDeps,
): PostTurnRuntimeHook & { getInterval: () => number; isInFlight: () => boolean } {
  const base = deps.baseInterval ?? 8
  let interval = base
  let lastFireTurn = -Infinity
  let lastStallFireTurn = -Infinity
  let inFlight = false
  /** complete 返回过 null → 基础设施不可用,永久休眠 */
  let unavailable = false
  /** 闸门未过的遥测只写一次,避免每轮噪音 */
  let gateTelemetryWritten = false

  function adoptionRate(stats: { adopted: number; ignored: number }): { rate: number; decided: number } {
    const decided = stats.adopted + stats.ignored
    return { rate: decided > 0 ? stats.adopted / decided : 0, decided }
  }

  /** 自我淘汰/恢复:按自身账本调节间隔 */
  function recalibrateInterval(): void {
    const own = deps.readback.getStats().get('copilot-advice')
    if (!own) return
    const { rate, decided } = adoptionRate(own)
    if (decided < SELF_ELIM_MIN_DECIDED) return
    if (rate < 0.25 && interval < MAX_INTERVAL) {
      interval = Math.min(interval * 2, MAX_INTERVAL)
      deps.writeTelemetry?.({ kind: 'copilot-recalibrate', direction: 'down', interval, adoptionRate: rate })
    } else if (rate >= 0.5 && interval > base) {
      interval = Math.max(base, Math.floor(interval / 2))
      deps.writeTelemetry?.({ kind: 'copilot-recalibrate', direction: 'up', interval, adoptionRate: rate })
    }
  }

  const hook: PostTurnRuntimeHook & { getInterval: () => number; isInFlight: () => boolean } = {
    phase: 'postTurn',
    name: 'async-copilot',
    getInterval: () => interval,
    isInFlight: () => inFlight,
    run(ctx: RuntimeHookContext): void {
      if (unavailable || inFlight) return
      const { turn, recentToolHistory, sensorium } = ctx.snapshot

      // ── 可行性闸门（运行时数据判定） ──
      const totals = adoptionRate(deps.readback.getTotals())
      if (totals.decided < COPILOT_GATE_MIN_DECIDED || totals.rate < COPILOT_GATE_MIN_ADOPTION) {
        if (totals.decided >= COPILOT_GATE_MIN_DECIDED && !gateTelemetryWritten) {
          gateTelemetryWritten = true
          deps.writeTelemetry?.({ kind: 'copilot-gate-closed', adoptionRate: totals.rate, decided: totals.decided })
        }
        return
      }

      // ── 触发判定:常规节流 或 stall 信号 ──
      const verifyFailStreak = computeVerifyFailStreak(recentToolHistory)
      const stalled = verifyFailStreak >= 2
        && (sensorium?.quality?.momentum !== 'no-data' && (sensorium?.momentum ?? 1) < 0.35)
      const regularDue = turn - lastFireTurn >= interval
      const stallDue = stalled && turn - lastStallFireTurn >= STALL_COOLDOWN
      if (!regularDue && !stallDue) return

      lastFireTurn = turn
      if (stallDue) lastStallFireTurn = turn

      // ── 情境包（~2-4KB 上限:工具序列截 10 条,目标截 500 字） ──
      const taskCtx = deps.getContext()
      const pack = [
        `目标: ${(taskCtx.objective ?? '(无任务契约)').slice(0, 500)}`,
        `星域: ${taskCtx.starDomain ?? '(未绑定)'}`,
        `轮次: ${turn}`,
        `sensorium: momentum=${(sensorium?.momentum ?? 0).toFixed(2)} pressure=${(sensorium?.pressure ?? 0).toFixed(2)} verifyCoverage=${(sensorium?.confidence ?? 0).toFixed(2)}${sensorium?.quality?.confidence === 'vacuous' ? '(空虚值)' : ''}`,
        `验证连败: ${verifyFailStreak}`,
        '最近工具序列(旧→新):',
        ...recentToolHistory.slice(-10).map(h => `  ${h.tool}(${(h.target ?? '').slice(0, 80)}) → ${h.status}`),
      ].join('\n')

      // ── 后台合成（不阻塞 turn;失败静默,副驾不值得让主控等） ──
      inFlight = true
      void deps.complete(SYSTEM_PROMPT, pack)
        .then(response => {
          if (response === null) {
            unavailable = true
            return
          }
          const parsed = parseCopilotResponse(response)
          if (!parsed) {
            deps.writeTelemetry?.({ kind: 'copilot-parse-failed', turn })
            return
          }
          deps.advisoryBus.submit({
            key: 'copilot-advice',
            priority: 0.5,
            category: 'star_domain',
            tier: 'informational',
            content: `【副驾】${parsed.advice}`,
            ttl: 2,
            expect: parsed.expect,
          })
          deps.writeTelemetry?.({ kind: 'copilot-advice', turn, hasExpect: parsed.expect !== undefined, trigger: stallDue ? 'stall' : 'interval' })
          recalibrateInterval()
        })
        .catch(() => { /* cheap model 失败不影响主链路 */ })
        .finally(() => { inFlight = false })
    },
  }

  return hook
}
