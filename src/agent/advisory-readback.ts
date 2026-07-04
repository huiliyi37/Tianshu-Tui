/**
 * Advisory Readback — advisory 采纳核销闭环（P1a, 2026-07-04 生命周期设计）。
 *
 * 问题：advisory 是发后不管的单向广播。submit → render → 没人知道模型是否照做。
 * 账本（Phase 0）只能回答"送达了多少"，回答不了"生效了多少"——习惯化对抗、
 * 降频淘汰、Phase 3 副驾自我优化全都缺数据地基。
 *
 * 机制（航空 readback 借喻：塔台指令要求机组复诵核销）：
 *   1. 送达跟踪 — turn-step-producer 在 render 后 drainDelivered()，把带
 *      expect 谓词的条目交给本模块（deliveredTurn = render 所在轮）。
 *   2. 行为观察 — advisory-readback-hook 的 postTool 半边把 turn 级工具事件
 *      喂进 observeTool()（完整 target + 错误状态，不依赖 traceStore 截断摘要）。
 *   3. 核销评估 — postTurn 半边调 evaluate()：正向谓词在窗口内满足 → adopted；
 *      到期未满足 → ignored；pattern_absent 到期时读文件判定。
 *   4. 账本输出 — 每个判定产出一条 outcome（drainOutcomes 供遥测落盘），
 *      同时维护 per-key 累计统计与 ignoredStreak（P1b 习惯化对抗的输入）。
 *
 * 状态 session-scoped：探针类谓词的观察窗口可跨多轮。
 */

import { readFileSync } from 'node:fs'
import type { AdvisoryExpectation, DeliveredAdvisory } from './advisory-bus.js'

/** 单条工具观察 — postTool 喂入,核销评估的证据源 */
export interface ObservedToolEvent {
  turn: number
  name: string
  /** bash → command;写/读类 → file_path;其余 → target 字段 */
  target: string
  isError: boolean
}

export type AdvisoryOutcome = 'adopted' | 'ignored'

/** 单次核销判定 — 供遥测落盘（kind: 'advisory-outcome';shadow 判定 kind: 'advisory-holdout'） */
export interface AdvisoryOutcomeEvent {
  key: string
  outcome: AdvisoryOutcome
  expectKind: AdvisoryExpectation['kind']
  deliveredTurn: number
  evaluatedTurn: number
  /** holdout 反事实组:true = 该条被静默扣留,outcome 度量的是"没提醒模型也做了吗" */
  shadow?: boolean
}

/** per-key 累计采纳统计 */
export interface AdvisoryKeyStats {
  delivered: number
  adopted: number
  ignored: number
  /** 连续 ignored 次数 — adopted 时清零。P1b 习惯化对抗的触发信号。 */
  ignoredStreak: number
  /** holdout 反事实组:被静默扣留的次数（不计入 delivered） */
  shadowHeld: number
  /** 扣留期内 expect 谓词仍被自发满足的次数——"没提醒也会做"的基线 */
  shadowSatisfied: number
}

interface PendingExpectation {
  key: string
  expect: AdvisoryExpectation
  deliveredTurn: number
  /** holdout 反事实组 — 核销进 shadow 桶,不影响 adopted/ignored/streak */
  shadow: boolean
}

/** 各谓词的缺省观察窗口（轮），含送达轮 */
const DEFAULT_WINDOW: Record<AdvisoryExpectation['kind'], number> = {
  tool_appears: 1,
  verify_attempted: 2,
  file_touched: 1,
  // 探针清理合法地可以晚几轮（修完再清）——窗口放宽
  pattern_absent: 4,
}

/** verify_attempted 认可的工具（与 self-verify/CCR 的 VERIFY 家族同源） */
const VERIFY_TOOL_NAMES = new Set(['run_tests', 'typecheck', 'lsp_diagnostics'])
/** bash 中的验证类命令（与 git-clear-after-fail 的 TEST_CMD_RE 同源） */
const VERIFY_BASH_RE = /\b(test|vitest|jest|pytest|mocha|tsx\s+--test|npm\s+(run\s+)?(test|typecheck)|tsc\b)/i

/** 观察日志保留的最大轮跨度 — pattern_absent 最长窗口 + 余量 */
const EVENT_RETENTION_TURNS = 8

/** 跨会话效能先验(EWMA 衰减后,可为小数)— seedPriors 注入 */
export interface EfficacyPriorCounts {
  delivered: number
  adopted: number
  ignored: number
  shadowHeld: number
  shadowSatisfied: number
}

/** 先验对副驾闸门决出样本的贡献上限——防陈旧数据永久锁定闸门方向 */
export const PRIOR_DECIDED_CAP = 20

/** 成熟 lift 的最小决出样本数（会话 + 先验合并后） */
export const MATURE_LIFT_MIN_DECIDED = 5
/** 成熟 lift 的最小 shadow 扣留样本数（会话 + 先验合并后） */
export const MATURE_LIFT_MIN_SHADOW = 3

export class AdvisoryReadback {
  private pending: PendingExpectation[] = []
  private events: ObservedToolEvent[] = []
  private stats = new Map<string, AdvisoryKeyStats>()
  private outcomes: AdvisoryOutcomeEvent[] = []
  /** 跨会话效能先验 — 只喂三个消费方(holdout 资格/副驾闸门/Top-N 次级排序),
   *  不进 getTotals/ignoredStreak(guardian meta 保持会话纯度,习惯化保持会话内) */
  private priors = new Map<string, EfficacyPriorCounts>()
  /** pattern_absent 判定用的文件读取器 — 注入以便测试;返回 null = 文件不存在 */
  constructor(private readFile: (path: string) => string | null = defaultReadFile) {}

  /** 注入跨会话先验(会话启动时一次)。 */
  seedPriors(priors: Iterable<[string, EfficacyPriorCounts]>): void {
    this.priors = new Map(priors)
  }

  /** 送达跟踪 — render 后调用。同 key 重复送达时重置观察窗口（不叠加 pending）。 */
  track(delivered: DeliveredAdvisory[], turn: number): void {
    for (const d of delivered) {
      const s = this.statsFor(d.key)
      const shadow = d.shadow === true
      if (shadow) s.shadowHeld++
      else s.delivered++
      if (!d.expect) continue
      const existing = this.pending.find(p => p.key === d.key)
      if (existing) {
        if (existing.shadow === shadow) {
          // 同组重复送达:刷新观察窗口
          existing.expect = d.expect
          existing.deliveredTurn = turn
          continue
        }
        // shadow 状态翻转 = 反事实 trial 被污染,作废 shadow 一侧:
        //   已有真实 pending + 新扣留 → 模型近期已见过提醒,扣留无对照价值;
        //   已有 shadow pending + 新真实送达 → 扣留期被打断,基线测不成。
        if (shadow) {
          s.shadowHeld = Math.max(0, s.shadowHeld - 1)
          continue // 保留真实 pending
        }
        s.shadowHeld = Math.max(0, s.shadowHeld - 1)
        existing.expect = d.expect
        existing.deliveredTurn = turn
        existing.shadow = false
        continue
      }
      this.pending.push({ key: d.key, expect: d.expect, deliveredTurn: turn, shadow })
    }
  }

  /** 行为观察 — postTool 喂入本轮工具事件 */
  observeTool(event: ObservedToolEvent): void {
    this.events.push(event)
    // 按轮跨度修剪（不按条数——重轮次 20+ 工具调用不能把窗口内证据挤掉）
    const cutoff = event.turn - EVENT_RETENTION_TURNS
    if (this.events.length > 0 && this.events[0]!.turn < cutoff) {
      this.events = this.events.filter(e => e.turn >= cutoff)
    }
  }

  /** 核销评估 — postTurn 调用。返回本轮判定数（0 = 无到期谓词）。 */
  evaluate(turn: number): number {
    if (this.pending.length === 0) return 0
    const still: PendingExpectation[] = []
    let decided = 0

    for (const p of this.pending) {
      const window = p.expect.withinTurns ?? DEFAULT_WINDOW[p.expect.kind]
      const deadline = p.deliveredTurn + window - 1

      let outcome: AdvisoryOutcome | null = null
      if (p.expect.kind === 'pattern_absent') {
        // 负向谓词只在到期时判定——过早读文件会把"还没来得及清"误判为忽略
        if (turn >= deadline) {
          outcome = this.checkPatternAbsent(p.expect) ? 'adopted' : 'ignored'
        }
      } else {
        const satisfied = this.checkPositive(p.expect, p.deliveredTurn, turn)
        if (satisfied) outcome = 'adopted'
        else if (turn >= deadline) outcome = 'ignored'
      }

      if (outcome === null) {
        still.push(p)
        continue
      }
      decided++
      const s = this.statsFor(p.key)
      if (p.shadow) {
        // 反事实组:只进 shadow 桶,不动 adopted/ignored/streak（不污染副驾闸门与习惯化）
        if (outcome === 'adopted') s.shadowSatisfied++
      } else if (outcome === 'adopted') {
        s.adopted++
        s.ignoredStreak = 0
      } else {
        s.ignored++
        s.ignoredStreak++
      }
      this.outcomes.push({
        key: p.key,
        outcome,
        expectKind: p.expect.kind,
        deliveredTurn: p.deliveredTurn,
        evaluatedTurn: turn,
        ...(p.shadow ? { shadow: true } : {}),
      })
    }

    this.pending = still
    return decided
  }

  /** 读取并清空本次评估以来的判定事件（遥测落盘用） */
  drainOutcomes(): AdvisoryOutcomeEvent[] {
    const out = this.outcomes
    this.outcomes = []
    return out
  }

  /** per-key 累计统计快照 */
  getStats(): ReadonlyMap<string, AdvisoryKeyStats> {
    return this.stats
  }

  /** 连续忽略次数 — P1b 习惯化对抗的查询入口 */
  getIgnoredStreak(key: string): number {
    return this.stats.get(key)?.ignoredStreak ?? 0
  }

  /** 历史送达次数（含跨会话先验）— holdout 资格判定入口（key 送达 ≥N 次才开始抽样） */
  getDeliveredCount(key: string): number {
    return (this.stats.get(key)?.delivered ?? 0) + (this.priors.get(key)?.delivered ?? 0)
  }

  /**
   * 采纳率（会话实测 + 先验合并)— AdvisoryBus Top-N 同 priority 次级排序键。
   * 无决出样本返回 null(排序时视为中性)。
   */
  getAdoptionRate(key: string): number | null {
    const s = this.stats.get(key)
    const p = this.priors.get(key)
    const adopted = (s?.adopted ?? 0) + (p?.adopted ?? 0)
    const decided = adopted + (s?.ignored ?? 0) + (p?.ignored ?? 0)
    if (decided <= 0) return null
    return adopted / decided
  }

  /**
   * 反事实 lift — 投递组采纳率减扣留组自发完成率。
   * 正 lift = 提醒有真实增益;lift≈0 = 模型本来就会做（提醒是纯噪音）。
   * 任一组无决出样本时返回 null（数据不足,不下结论）。
   */
  getLift(key: string): number | null {
    const s = this.stats.get(key)
    if (!s) return null
    const decided = s.adopted + s.ignored
    if (decided === 0 || s.shadowHeld === 0) return null
    return s.adopted / decided - s.shadowSatisfied / s.shadowHeld
  }

  /**
   * 成熟 lift — 会话实测 + 跨会话先验合并计算,过成熟度门才下结论。
   * 会话内 holdout 积累极慢(单会话通常 0-2 个 shadow 样本),先验是冷启动的
   * 主数据源;EWMA 衰减保证陈旧历史权重递减。样本不足返回 null——
   * 消费端(负 lift 静音/排序升级)对 null 必须视为中性,不得下静音结论。
   */
  getMatureLift(key: string): number | null {
    const s = this.stats.get(key)
    const p = this.priors.get(key)
    const adopted = (s?.adopted ?? 0) + (p?.adopted ?? 0)
    const ignored = (s?.ignored ?? 0) + (p?.ignored ?? 0)
    const shadowHeld = (s?.shadowHeld ?? 0) + (p?.shadowHeld ?? 0)
    const shadowSatisfied = (s?.shadowSatisfied ?? 0) + (p?.shadowSatisfied ?? 0)
    const decided = adopted + ignored
    if (decided < MATURE_LIFT_MIN_DECIDED || shadowHeld < MATURE_LIFT_MIN_SHADOW) return null
    return adopted / decided - shadowSatisfied / shadowHeld
  }

  /**
   * Phase 2 自愈判定 — expect 谓词在 [sinceTurn, nowTurn] 观察窗口内是否已被
   * 自发满足（模型没被提醒就做了该做的事 → 挂起条目撤销,不投递）。
   * pattern_absent 直接读当前文件状态（已不在 = 已自愈）。
   */
  wasSatisfiedBetween(expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number): boolean {
    if (expect.kind === 'pattern_absent') return this.checkPatternAbsent(expect)
    return this.checkPositive(expect, sinceTurn, nowTurn)
  }

  /** 会话累计采纳/忽略计数（guardian meta 摘要用,不含先验——会话纯度） */
  getTotals(): { adopted: number; ignored: number } {
    let adopted = 0
    let ignored = 0
    for (const s of this.stats.values()) {
      adopted += s.adopted
      ignored += s.ignored
    }
    return { adopted, ignored }
  }

  /**
   * 含先验的累计采纳/忽略 — 副驾可行性闸门用（消灭"每会话前十几轮沉睡"的
   * 冷启动)。先验决出样本贡献上限 PRIOR_DECIDED_CAP,按比例缩放保采纳率:
   * 陈旧历史只能开门,不能永久压制会话内的新证据。
   */
  getTotalsWithPriors(): { adopted: number; ignored: number } {
    const session = this.getTotals()
    let pAdopted = 0
    let pIgnored = 0
    for (const p of this.priors.values()) {
      pAdopted += p.adopted
      pIgnored += p.ignored
    }
    const pDecided = pAdopted + pIgnored
    if (pDecided > PRIOR_DECIDED_CAP) {
      const scale = PRIOR_DECIDED_CAP / pDecided
      pAdopted *= scale
      pIgnored *= scale
    }
    return { adopted: session.adopted + pAdopted, ignored: session.ignored + pIgnored }
  }

  reset(): void {
    this.pending = []
    this.events = []
    this.stats.clear()
    this.outcomes = []
    this.priors.clear()
  }

  private statsFor(key: string): AdvisoryKeyStats {
    let s = this.stats.get(key)
    if (!s) {
      s = { delivered: 0, adopted: 0, ignored: 0, ignoredStreak: 0, shadowHeld: 0, shadowSatisfied: 0 }
      this.stats.set(key, s)
    }
    return s
  }

  private checkPositive(
    expect: Exclude<AdvisoryExpectation, { kind: 'pattern_absent' }>,
    from: number,
    to: number,
  ): boolean {
    const windowEvents = this.events.filter(e => e.turn >= from && e.turn <= to)
    switch (expect.kind) {
      case 'tool_appears':
        return windowEvents.some(e => {
          if (expect.tools.length > 0 && !expect.tools.includes(e.name)) return false
          if (expect.targetIncludes && !e.target.includes(expect.targetIncludes)) return false
          return true
        })
      case 'verify_attempted':
        return windowEvents.some(e =>
          VERIFY_TOOL_NAMES.has(e.name) ||
          (e.name === 'bash' && VERIFY_BASH_RE.test(e.target)),
        )
      case 'file_touched':
        return windowEvents.some(e => expect.paths.some(p => e.target.includes(p)))
    }
  }

  private checkPatternAbsent(expect: Extract<AdvisoryExpectation, { kind: 'pattern_absent' }>): boolean {
    const content = this.readFile(expect.path)
    if (content === null) return true // 文件已删除 = 探针已不存在
    return !expect.needles.some(n => content.includes(n))
  }
}

function defaultReadFile(path: string): string | null {
  try {
    // 仅 pattern_absent 到期时读一次,源码文件同步读可接受
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
