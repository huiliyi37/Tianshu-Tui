/**
 * 统一劝导总线 — 将五条独立纠偏通道收敛为单一 <星域-advisory> 汇聚器。
 *
 * 通道来源：
 *   1. immune projection（loop.ts — 自体免疫投射）
 *   2. repair-hint appendix（volatile.ts — 修复提示）
 *   3. MistakeNotebook（tool-pipeline.ts — 工具错误模式匹配）
 *   4. dedup-guard（dedup-guard-hook.ts — 重复输出检测）
 *   5. stigmergy dead-end（signal-consumer-hook.ts — 死路信号）
 *
 * 约束：
 *   - constitutional tier 条目永不被截断
 *   - non-constitutional 条目每轮最多 3 条（operational 优先，informational 填空）
 *   - 同 key 去重（同一劝导不在同轮重复出现）
 */

export type AdvisoryTier = 'constitutional' | 'operational' | 'informational'

export interface AdvisoryEntry {
  /** 去重键 — 同 key 在同轮只保留优先级最高的一条 */
  key: string
  /** 优先级，越高越靠前（0-1 归一化） */
  priority: number
  /** 分类标签 */
  category: AdvisoryCategory
  /** 渲染内容 — 单行纯文本，不包含 XML 标签 */
  content: string
  /** 优先级层 — constitutional 永不被截断，operational 参与 Top-N，informational 填空 */
  tier?: AdvisoryTier
  /** TTL（轮次），默认为 1（仅本轮） */
  ttl?: number
}

export type AdvisoryCategory =
  | 'immune'
  | 'repair'
  | 'mistake'
  | 'dedup'
  | 'dead_end'
  | 'cerebellar'
  | 'discipline'
  | 'encouragement'
  | 'constitutional'
  | 'delegation'
  | 'typecheck'

/**
 * 宪法级优先级 — 构成性规则（不可违抗的行为底线）。
 *
 * 高于所有管制性条目（discipline/repair/mistake 等最高 0.65），
 * 确保宪法 violation 信号不会被习惯化对抗 / 纪律重锚条目挤掉。
 * 用于信念宪法退化的恢复：当 sycophancy trap 检测到连续投降 +
 * confidence 递减模式时，courage-hook 通过 advisory bus 投递的
 * 宪法级 entry 必须始终获得渲染位（不受每轮 3 条上限挤压）。
 */
export const CONSTITUTIONAL_PRIORITY = 0.9

/** 每轮最大渲染条数（non-constitutional 上限） */
const MAX_ADVISORIES_PER_TURN = 3
/** 每个 category 最多保留条数，防止单一信号源垄断 advisory 预算 */
const MAX_PER_CATEGORY = 2

// ─── F-fix（session 803d897d）：纪律抗习惯化重锚 ─────────────────────
// execute 阶段 field habituation（alpha=0.35）让 activeDomain 纪律约 4 轮后
// 移入 consolidated 区；单轮 20+ 工具调用后纪律文本落后数万 token。
// 每 N 次工具调用经 advisory bus 重锚一行纪律摘要——走 dynamic appendix
// 单一出口，缓存安全，不豁免习惯化、不动 frozen 前缀。

/** 每多少次工具调用重锚一次纪律摘要 */
export const DISCIPLINE_REANCHOR_INTERVAL = 15

/**
 * 纪律同义改写池 — 每次重锚随机选取一个表述。
 * 同义替换让长会话中同一纪律点以不同字节出现，
 * 抵抗 attention-level 习惯化（字段级习惯化由 FieldHabituationTracker 处理，
 * 这里处理文本级习惯化）。
 */
const DISCIPLINE_VARIANTS: string[] = [
  '【天梁】交付纪律重锚：新增字段/符号先 grep 读侧消费方（0 消费方 = 死接线）；改行为先跑 related_tests；闭环 = 从生产入口正向追到改动点，typecheck 绿 ≠ 闭环。',
  '【天梁】接线检查：新增 export 前 grep 谁会 import 它——无消费方说明接线断裂。改逻辑后 related_tests 必须跑过。验证闭环 = 入口到改动点全路径通。',
  '【天梁】交付前自检：新符号有消费方吗？行为变更有测试覆盖吗？从真实入口能追踪到你的改动吗？三个"是"才算闭环。',
  '【天梁】节奏检查：读→改→验证→提交，这四步跳了哪步？改了什么就验证什么，不积累未验证的改动。',
  '【天梁】分波纪律：当前铺开了几个任务？>=4 就该分波。"完成感"压过验证纪律是分波要防的失败模式。',
  '【天梁】闭环追踪：改了数据流字段？grep 所有消费方。新建了模块？验证至少一个调用方在使用。管道通了不算完，数据走通才算。',
]

/** 单行交付纪律摘要 — 每次调用随机选取同义表述以抵抗文本级习惯化 */
export function disciplineReanchorEntry(): AdvisoryEntry {
  const variant = DISCIPLINE_VARIANTS[Math.floor(Math.random() * DISCIPLINE_VARIANTS.length)]!
  return {
    key: 'discipline-reanchor',
    priority: 0.55,
    category: 'discipline',
    content: variant,
  }
}

/**
 * 新鲜度衰减门 — 当 session 较长且近期无主动异议时触发。
 * @deprecated Replaced by CognitiveCapsuleRouter rule P2 (freshness < 0.25).
 * Kept for backward compatibility; callers should migrate to CCR.
 */
export const STALENESS_GATE_TURN_THRESHOLD = 20
export const STALENESS_GATE_QUIET_WINDOW = 10

/** @deprecated Use CCR rule P2 instead. */
export function stalenessGateEntry(turnsSinceLastObjection: number): AdvisoryEntry {
  return {
    key: 'staleness-gate',
    priority: 0.6,
    category: 'discipline',
    content: `【天璇】你已执行 ${turnsSinceLastObjection}+ 轮未提出异议。快速自检：当前方向有隐患吗？有遗留项在累积吗？天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall。`,
    ttl: 2,
  }
}

/**
 * Vigor 低迷唤醒 — 当执行能量（tonic）过低时注入具体化行动指引。
 * @deprecated Replaced by CognitiveCapsuleRouter rule P3 (verif_cov < 0.3 ∧ vigor < 0.3).
 * Kept for backward compatibility; callers should migrate to CCR.
 */
export function vigorLowEntry(): AdvisoryEntry {
  return {
    key: 'vigor-low-refresh',
    priority: 0.65,
    category: 'discipline',
    content: '【天枢】执行能量偏低。回到证据：最后一个成功验证的事实是什么？下一步最小可验证行动是什么？',
    ttl: 1,
  }
}

// ─── 正向激励条目 ─────────────────────────────────────────────────
// 当 agent 做出好的决策时，通过 advisory bus 注入简短的正向反馈。
// 归属到对应的星域，让 agent 感知到多元认知场的存在。

const VIRTUE_ENCOURAGEMENT_VARIANTS: string[] = [
  '【瑶光】好的决策——你在验证之前没有跳到下一个任务。这种节奏值得保持。',
  '【天权】称量到位——改动和验证形成了闭环。继续保持这个审查精度。',
  '【天梁】执行节奏优秀——读→改→验证→提交，四步无遗漏。',
]

export function virtueEncouragementEntry(): AdvisoryEntry {
  const variant = VIRTUE_ENCOURAGEMENT_VARIANTS[Math.floor(Math.random() * VIRTUE_ENCOURAGEMENT_VARIANTS.length)]!
  return {
    key: 'virtue-encouragement',
    priority: 0.4,
    category: 'encouragement',
    content: variant,
    ttl: 1,
  }
}

export function testPassEncouragementEntry(testCount: number): AdvisoryEntry {
  return {
    key: 'test-pass-encouragement',
    priority: 0.35,
    category: 'encouragement',
    content: `【天府】${testCount} 个测试全部通过。代码质量守护有效。`,
    ttl: 1,
  }
}

export function vigorRecoveryEntry(): AdvisoryEntry {
  return {
    key: 'vigor-recovery',
    priority: 0.35,
    category: 'encouragement',
    content: '【天枢】执行能量恢复。你从低效状态走出来了，保持当前的行动节奏。',
    ttl: 1,
  }
}

export class AdvisoryBus {
  private entries: AdvisoryEntry[] = []
  /** 存活条目 — 未过期的跨轮条目 */
  private alive: AdvisoryEntry[] = []

  /** 投递一条劝导 */
  submit(entry: AdvisoryEntry): void {
    this.entries.push(entry)
  }

  /** 批量投递 */
  submitAll(entries: AdvisoryEntry[]): void {
    this.entries.push(...entries)
  }

  /**
   * 渲染本轮劝导为 `<星域-advisory>` XML 块。
   *
   * 分层规则：
   *   constitutional tier — 永不被截断，仅按 key 去重
   *   operational tier — 参与 Top-3 竞争（先于 informational）
   *   informational tier — 填充剩余槽位
   *
   * @param activeStarDomain — active star domain name (e.g. '天枢'). When set,
   *   advisory entries whose content starts with the same star name are suppressed.
   */
  render(activeStarDomain?: string): string {
    let all = [...this.alive, ...this.entries]

    // Star-domain dedup
    if (activeStarDomain) {
      const tag = `【${activeStarDomain}】`
      all = all.filter(e => !e.content.startsWith(tag))
    }

    // Separate by tier — constitutional bypasses all caps
    const constitutional = all.filter(e => e.tier === 'constitutional')
    const nonConstitutional = all.filter(e => e.tier !== 'constitutional')

    // Constitutional: key dedup only, no category cap, no count limit
    const constDeduped = new Map<string, AdvisoryEntry>()
    for (const entry of constitutional) {
      const existing = constDeduped.get(entry.key)
      if (!existing || entry.priority > existing.priority) {
        constDeduped.set(entry.key, entry)
      }
    }

    // Non-constitutional: key dedup + category cap
    const deduped = new Map<string, AdvisoryEntry>()
    for (const entry of nonConstitutional) {
      const existing = deduped.get(entry.key)
      if (!existing || entry.priority > existing.priority) {
        deduped.set(entry.key, entry)
      }
    }

    const catCounts = new Map<AdvisoryCategory, number>()
    const catFiltered: AdvisoryEntry[] = []
    for (const entry of [...deduped.values()].sort((a, b) => b.priority - a.priority)) {
      const count = catCounts.get(entry.category) ?? 0
      if (count < MAX_PER_CATEGORY) {
        catCounts.set(entry.category, count + 1)
        catFiltered.push(entry)
      }
    }

    // Operational first, then informational fills remaining
    const operational = catFiltered.filter(e => e.tier !== 'informational')
    const informational = catFiltered.filter(e => e.tier === 'informational')
    const taken: AdvisoryEntry[] = []
    for (const e of operational) {
      if (taken.length >= MAX_ADVISORIES_PER_TURN) break
      taken.push(e)
    }
    for (const e of informational) {
      if (taken.length >= MAX_ADVISORIES_PER_TURN) break
      taken.push(e)
    }

    // Combine: constitutional always first, then by priority
    const sorted: AdvisoryEntry[] = [...constDeduped.values()]
    taken.sort((a, b) => b.priority - a.priority)
    sorted.push(...taken)

    if (sorted.length === 0) {
      this.entries = []
      this.alive = []
      return ''
    }

    const lines = sorted.map(e =>
      `  <entry key="${escapeXml(e.key)}" priority="${e.priority.toFixed(2)}" category="${e.category}">${escapeXml(e.content)}</entry>`
    )

    // TTL 递减：TTL > 1 的条目保留到 alive，下轮继续
    this.alive = sorted
      .filter(e => (e.ttl ?? 1) > 1)
      .map(e => ({ ...e, ttl: (e.ttl ?? 1) - 1 }))

    this.entries = []

    return `<星域-advisory>\n${lines.join('\n')}\n</星域-advisory>`
  }

  /** 清空所有状态 */
  reset(): void {
    this.entries = []
    this.alive = []
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
