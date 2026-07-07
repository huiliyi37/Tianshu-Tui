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

/**
 * expect 谓词 — 描述"这条提醒被采纳时,后续轮次应该能观察到什么行为"。
 *
 * P1a（2026-07-04 advisory 生命周期设计）：advisory 此前是发后不管的
 * 单向广播——没人知道模型是否照做。expect 让每条提醒携带一个可客观核销
 * 的行为签名,postTurn 由 advisory-readback-hook 对照 turn 级工具事件核销,
 * 产出 adopted/ignored 账本（习惯化对抗与 Phase 3 降频的数据地基）。
 *
 * 语义约定:
 *   - `withinTurns`: 观察窗口（含送达轮）,缺省 1 = 只看送达当轮。
 *   - `tool_appears` 的 `tools: []` 表示"任意工具调用即算采纳"
 *     （即计划中的 tool_stops 反向谓词:无工具僵局被打破）。
 *   - `pattern_absent` 是负向谓词:到期时目标文件不再包含任何 needle
 *     （子串匹配,如探针残留的行内容）→ 采纳。文件消失也算采纳。
 */
export type AdvisoryExpectation =
  | {
      kind: 'tool_appears'
      tools: string[]
      /** 可选 target 约束 — 工具的 target 需包含此片段（如特定文件路径） */
      targetIncludes?: string
      withinTurns?: number
    }
  | { kind: 'verify_attempted'; withinTurns?: number }
  | { kind: 'file_touched'; paths: string[]; withinTurns?: number }
  | { kind: 'pattern_absent'; path: string; needles: string[]; withinTurns?: number }

/**
 * Phase 2 投递通道（2026-07-04 生命周期设计）：
 *   'bus'（缺省）— `<星域-advisory>` 附录块,下个请求构建时可见（粗断点）
 *   'system-reminder' — session.appendSystemReminder 进消息流（细断点,
 *     模型必读通道；缓存安全:只追加尾部,不重写历史）
 *   'status' — 仅进 TUI 状态区不进 prompt（dark cockpit 单感官通道）。
 *     无 status sink 时回退 bus 渲染——宁可占预算不静默消失。
 */
export type AdvisoryChannel = 'bus' | 'system-reminder' | 'status'

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
  /** 采纳核销谓词 — 缺省则该条不参与采纳率统计（只计送达） */
  expect?: AdvisoryExpectation
  // ── Phase 2 生命周期字段 ──
  /** 跳过挂起观察与阶段抑制,直达投递（按 hook 语义标记,如 git-clear 事后守护） */
  immediate?: boolean
  /** 挂起观察:先挂 N 个渲染周期。窗口内 expect 谓词已被自发满足 → 自愈撤销
   *  （不投递）;被其他条目 corroborates 指认 → 提前确认;到期 → 强制送达。
   *  constitutional / immediate 条目忽略此字段。 */
  observe?: { turns: number }
  /** 多信号确认:本条目作为独立信号,可提前确认这些 key 的挂起条目
   *  （独立性由提交方保证:不同 phase 或不同 category 的 hook 才互相指认） */
  corroborates?: string[]
  /** 投递通道,缺省 'bus' */
  channel?: AdvisoryChannel
}

/** render() 实际送达的条目快照 — 供 readback 跟踪（send 侧账本的"已送达"半边） */
export interface DeliveredAdvisory {
  key: string
  category: AdvisoryCategory
  tier?: AdvisoryTier
  expect?: AdvisoryExpectation
  /** holdout 反事实组:该条赢得渲染位但被静默扣留（未渲染）,readback 核销进 shadow 桶 */
  shadow?: boolean
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
  | 'todo'
  | 'background'
  /** 星域路由（CCR）与胶囊召回 — 独立类别，不与 discipline 争 MAX_PER_CATEGORY
   *  预算（2026-07-04 触发面修复：discipline 赛道扩容后 CCR 0.55 常被挤出）。 */
  | 'star_domain'

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

// 死代码清理（2026-07-04）：deprecated 的 stalenessGateEntry / vigorLowEntry 已删除。
// 它们声称"被 CCR P2/P3 替代"，但 P2 早已被裁（c43660f0）且两函数零生产调用方——
// 胶囊召回的提醒通路由此断裂。召回现在是 CCR 触发的一等附属（见 cognitive-capsule-router.ts）。

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

/**
 * 投递账本快照 — 自上次 drain 以来的投递/渲染/丢弃计数。
 * Phase 0 观测：advisory 被预算挤掉时不再静默——被丢弃的 key 可从遥测回放。
 */
export interface AdvisoryLedgerDelta {
  /** submit/submitAll 收到的条目数 */
  submitted: number
  /** render 实际输出的条目数 */
  rendered: number
  /** 参与竞争但未获渲染位的条目数（含星域过滤、类别上限、Top-N 截断） */
  dropped: number
  /** 被丢弃条目的 key（去重后，最多保留最近 50 个） */
  droppedKeys: string[]
  /** 负 lift 静音丢弃数（"没提醒也会做"的纯噪音 key,已计入 dropped） */
  liftMuted: number
  /** Phase 2:进入挂起观察 / 被阶段抑制推迟的条目数（挂起 ≠ 丢弃） */
  deferred: number
  /** Phase 2:挂起期内自愈撤销的条目数（模型自发做了该做的事,提醒作废） */
  revoked: number
  /** holdout:赢得渲染位但被反事实扣留的条目数 */
  heldOut: number
}

const LEDGER_DROPPED_KEYS_CAP = 50

// ─── P1b 习惯化对抗 ────────────────────────────────────────────────
// 核销账本（AdvisoryReadback）显示某 key 连续被忽略时的两级反应：
//   streak >= 2 → 升级措辞：在条目前标注"已连续 N 次未见执行"——被忽略的
//     事实本身是新信息，比原文重复更能穿透注意力习惯化。
//   streak >= 3 → 有界静音：连续无效的提醒是纯噪音，静音 N 个渲染周期。
//     期满放行一次（probation）：若那次被采纳则 streak 清零恢复正常；
//     仍被忽略（streak 增长）才再次静音。constitutional tier 永不静音。

/** 触发升级措辞的最低连续忽略次数 */
export const HABITUATION_ESCALATE_STREAK = 2
/** 触发静音的最低连续忽略次数 */
export const HABITUATION_SILENCE_STREAK = 3
/** 每次静音持续的渲染周期数 */
export const HABITUATION_SILENCE_RENDERS = 4

/** 负 lift 静音的渲染周期数（期满 probation 放行一次收集新证据） */
export const LIFT_MUTE_RENDERS = 10
/** lift ≤ 此阈值判定为"提醒无真实增益"（成熟样本前提下） */
export const LIFT_MUTE_THRESHOLD = 0

/** 习惯化查询接口 — 由 AdvisoryReadback 实现（结构化鸭子类型，便于测试） */
export interface HabituationPolicy {
  getIgnoredStreak(key: string): number
}

// ─── Holdout 反事实抽样（因果账本,2026-07-04 天枢复核版）────────────
// 采纳率度量的是相关性——"送达后 2 轮内出现验证"可能是模型本来就要做。
// 按小概率把赢得渲染位的条目静默扣留（不渲染,照常核销 expect）,对比
// 投递组采纳率 vs 扣留组自发完成率 → 每 key 的真实 lift。
// 本轮只度量不自动退役;lift 数据积累后再做规则退役。

/** holdout 缺省抽样率。可用 RIVET_ADVISORY_HOLDOUT 环境变量覆盖（0 关闭）。 */
export const DEFAULT_HOLDOUT_RATE = 0.1
/** key 历史送达 ≥N 次才开始抽样——冷 key 先积累投递组基数 */
export const HOLDOUT_MIN_DELIVERED = 3

/** RIVET_ADVISORY_HOLDOUT 解析:合法 [0,1] 数字生效,'0' 关闭,非法/缺省用默认率 */
export function parseHoldoutRate(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_HOLDOUT_RATE
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_HOLDOUT_RATE
  return n
}

/** holdout 策略 — 资格历史判定由调用方注入（AdvisoryReadback / 效能信息素先验） */
export interface HoldoutPolicy {
  /** 抽样率 [0,1],0 = 关闭 */
  rate: number
  /** key 级资格（如历史送达 ≥ HOLDOUT_MIN_DELIVERED） */
  isEligible(key: string): boolean
  /** 可注入 RNG（测试确定性）,缺省 Math.random */
  rng?: () => number
}

// ─── Phase 2 打断调度常量 ─────────────────────────────────────────
// 阶段抑制白名单（天枢建议,已核准）：仅抑制锦上添花类信号。
// discipline / constitutional / star_domain 不受阶段抑制——抑制判据（产出流）
// 与守护触发判据（如连续无工具）不是同一信号,全局静音会误杀守护。
const FLOW_SUPPRESSIBLE_CATEGORIES: ReadonlySet<AdvisoryCategory> = new Set(['encouragement', 'typecheck'])
/** 阶段抑制最多推迟的渲染周期数 — 到限强制送达（TTL 强制送达红线） */
const FLOW_SUPPRESS_MAX_DEFERRALS = 2

export class AdvisoryBus {
  private entries: AdvisoryEntry[] = []
  /** 存活条目 — 未过期的跨轮条目 */
  private alive: AdvisoryEntry[] = []
  // ── 投递账本（Phase 0 观测）──
  private ledgerSubmitted = 0
  private ledgerRendered = 0
  private ledgerDropped = 0
  private ledgerDroppedKeys: string[] = []
  // ── P1a 核销闭环：render 实际送达的条目（供 advisory-readback 追踪采纳） ──
  private delivered: DeliveredAdvisory[] = []
  // ── P1b 习惯化对抗 ──
  private habituation: HabituationPolicy | null = null
  /** key → 剩余静音渲染周期数 */
  private silenceRemaining = new Map<string, number>()
  /** key → 上次触发静音时的 ignoredStreak（防止同一 streak 反复静音，保证 probation 放行） */
  private lastSilencedStreak = new Map<string, number>()
  // ── Phase 2 状态机 ──
  private ledgerDeferred = 0
  private ledgerRevoked = 0
  /** 挂起观察中的条目（candidate → pending）。挂起态不渲染 = 不产生附录抖动。 */
  private pendingWatch: Array<{ entry: AdvisoryEntry; startTurn: number; waitedRenders: number }> = []
  /** 阶段抑制推迟的条目（保 TTL 强制送达:deferrals 到上限必须投递） */
  private suppressedCarry: Array<{ entry: AdvisoryEntry; deferrals: number }> = []
  /** 自愈判定 — 挂起窗口内 expect 谓词是否已被自发满足（wire 到 AdvisoryReadback） */
  private selfHealCheck: ((expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number) => boolean) | null = null
  /** 产出流判定 — true 时对白名单类别做阶段抑制（navigator 沉默规则） */
  private flowStateProvider: (() => boolean) | null = null
  /** status 通道 sink — 未设置时 status 条目回退 bus 渲染（不静默消失） */
  private statusSink: ((entries: AdvisoryEntry[]) => void) | null = null
  /** system-reminder 通道待送内容（drainSystemReminders 取走） */
  private systemReminderOut: string[] = []
  // ── Holdout 反事实抽样 ──
  private holdout: HoldoutPolicy | null = null
  private ledgerHeldOut = 0
  /** Top-N 同 priority 次级排序键 — 历史采纳率（跨会话先验 + 会话实测,B）。
   *  null = 无数据,视为中性(排两者之后不如有正数据的,先于有负数据的)。 */
  private adoptionRateProvider: ((key: string) => number | null) | null = null
  /** 星域措辞适配 — 渲染出口处按当前域改写条目内容（见 domain-advisory-tone.ts）。
   *  null = 恒等。只影响送达文本,不影响 key/expect/账本。 */
  private toneAdapter: ((content: string, meta: { key: string; category: AdvisoryCategory; tier?: AdvisoryTier }) => string) | null = null
  // ── Lift 消费端（因果账本闭环,2026-07-04 第四轮）──
  /** 成熟 lift 查询 — null = 样本不足不下结论。 */
  private liftProvider: ((key: string) => number | null) | null = null
  /** key → 负 lift 静音的剩余渲染周期数（与习惯化 silenceRemaining 独立,遥测可区分） */
  private liftMuteRemaining = new Map<string, number>()
  /** 静音期满后的 probation 名单 — 放行一次送达以收集新证据,之后 lift 仍 ≤0 才再静音 */
  private liftProbation = new Set<string>()
  private ledgerLiftMuted = 0

  /** P1b：注入习惯化查询源（AdvisoryReadback）。缺省 = 不做习惯化对抗。 */
  setHabituationPolicy(policy: HabituationPolicy): void {
    this.habituation = policy
  }

  /** Phase 2：注入自愈判定（挂起观察需要;缺省 = 挂起只按 TTL 到期送达）。 */
  setSelfHealCheck(check: (expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number) => boolean): void {
    this.selfHealCheck = check
  }

  /** Phase 2：注入产出流判定（阶段抑制需要;缺省 = 不抑制）。 */
  setFlowStateProvider(provider: () => boolean): void {
    this.flowStateProvider = provider
  }

  /** Phase 2：注入 TUI 状态区 sink。设置后 channel='status' 条目改走此通道。 */
  setStatusSink(sink: (entries: AdvisoryEntry[]) => void): void {
    this.statusSink = sink
  }

  /** Holdout：注入反事实抽样策略。缺省 = 不抽样（全量投递）。 */
  setHoldoutPolicy(policy: HoldoutPolicy): void {
    this.holdout = policy
  }

  /** B：注入历史采纳率查询 — Top-N 预算竞争同 priority 时的次级排序键。 */
  setAdoptionRateProvider(provider: (key: string) => number | null): void {
    this.adoptionRateProvider = provider
  }

  /** 星域措辞适配器 — 在渲染出口（bus 附录块 + system-reminder 通道）改写
   *  条目文本。惰性求值:适配器每次渲染时执行,域切换自动生效。 */
  setToneAdapter(adapter: (content: string, meta: { key: string; category: AdvisoryCategory; tier?: AdvisoryTier }) => string): void {
    this.toneAdapter = adapter
  }

  /** 应用措辞适配（无适配器 = 恒等）。适配器抛错时回退原文——措辞是增强,
   *  永不阻断送达。 */
  private applyTone(e: AdvisoryEntry): string {
    if (!this.toneAdapter) return e.content
    try {
      return this.toneAdapter(e.content, { key: e.key, category: e.category, tier: e.tier })
    } catch {
      return e.content
    }
  }

  /** Lift 消费端：注入成熟 lift 查询（AdvisoryReadback.getMatureLift）。
   *  缺省 = 不消费 lift（不静音,排序回退采纳率）。 */
  setLiftProvider(provider: (key: string) => number | null): void {
    this.liftProvider = provider
  }

  /** 静音中的 key（习惯化 + 负 lift）— cockpit advisory 面板观测口。 */
  getSilencedKeys(): Array<{ key: string; remaining: number; reason: 'habituation' | 'lift' }> {
    return [
      ...[...this.silenceRemaining].map(([key, remaining]) => ({ key, remaining, reason: 'habituation' as const })),
      ...[...this.liftMuteRemaining].map(([key, remaining]) => ({ key, remaining, reason: 'lift' as const })),
    ]
  }

  /** 挂起观察中的条目数 — cockpit advisory 面板观测口。 */
  getPendingWatchCount(): number {
    return this.pendingWatch.length
  }

  /** Phase 2：取走 system-reminder 通道的待送内容（调用方负责 appendSystemReminder）。 */
  drainSystemReminders(): string[] {
    const out = this.systemReminderOut
    this.systemReminderOut = []
    return out
  }

  /** 投递一条劝导 */
  submit(entry: AdvisoryEntry): void {
    this.entries.push(entry)
    this.ledgerSubmitted++
  }

  /** 批量投递 */
  submitAll(entries: AdvisoryEntry[]): void {
    this.entries.push(...entries)
    this.ledgerSubmitted += entries.length
  }

  /** 读取并清零投递账本（自上次 drain 以来的增量） */
  drainLedger(): AdvisoryLedgerDelta {
    const delta: AdvisoryLedgerDelta = {
      submitted: this.ledgerSubmitted,
      rendered: this.ledgerRendered,
      dropped: this.ledgerDropped,
      droppedKeys: [...new Set(this.ledgerDroppedKeys)],
      deferred: this.ledgerDeferred,
      revoked: this.ledgerRevoked,
      heldOut: this.ledgerHeldOut,
      liftMuted: this.ledgerLiftMuted,
    }
    this.ledgerSubmitted = 0
    this.ledgerRendered = 0
    this.ledgerDropped = 0
    this.ledgerDroppedKeys = []
    this.ledgerDeferred = 0
    this.ledgerRevoked = 0
    this.ledgerHeldOut = 0
    this.ledgerLiftMuted = 0
    return delta
  }

  /**
   * 读取并清空"已送达"条目快照（自上次 drain 以来 render 输出过的条目）。
   * turn-step-producer 在 render 后立刻 drain 并交给 AdvisoryReadback 跟踪。
   */
  drainDelivered(): DeliveredAdvisory[] {
    const out = this.delivered
    this.delivered = []
    return out
  }

  private recordDropped(keys: Iterable<string>): void {
    for (const key of keys) {
      this.ledgerDropped++
      this.ledgerDroppedKeys.push(key)
    }
    if (this.ledgerDroppedKeys.length > LEDGER_DROPPED_KEYS_CAP) {
      this.ledgerDroppedKeys = this.ledgerDroppedKeys.slice(-LEDGER_DROPPED_KEYS_CAP)
    }
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
   *   static manifesto-style entries tagged with the same star name are
   *   suppressed (they duplicate the persona already rendered in the frozen
   *   base). Situational entries (category 'star_domain' — CCR routing and
   *   capsule recall) are exempt: a 【天权】 course-correction fired while the
   *   天权 domain is active is contextual advice, not a duplicate manifesto.
   *   (2026-07-04 触发面修复：旧逻辑按内容前缀无差别过滤，同星域的改道提醒
   *   被静态 persona 顶掉——静音栈的一环。)
   */
  render(activeStarDomain?: string, turn = 0): string {
    // ── Phase 2 状态机:candidate → pending → confirmed/revoked ──
    // A. 先处理既有挂起（新条目在 B 段才入队——观察进度从下个渲染周期起算,
    //    否则 observe.turns=1 会在挂起当轮就被判到期,挂起形同虚设）:
    //    corroborate 提前确认 → 自愈撤销 → TTL 到期强制送达
    const corroboratedKeys = new Set<string>()
    for (const e of [...this.alive, ...this.entries]) {
      for (const k of e.corroborates ?? []) corroboratedKeys.add(k)
    }
    const promoted: AdvisoryEntry[] = []
    const stillPending: typeof this.pendingWatch = []
    for (const p of this.pendingWatch) {
      if (corroboratedKeys.has(p.entry.key)) {
        // 多信号确认:独立信号（不同 phase/category 的 hook）指认 → 提前送达
        promoted.push(p.entry)
        continue
      }
      if (this.selfHealCheck && p.entry.expect && this.selfHealCheck(p.entry.expect, p.startTurn, turn)) {
        // 自愈撤销:模型在挂起期已自发做了该做的事——提醒作废（ICU 延迟确认降误报）
        this.ledgerRevoked++
        continue
      }
      p.waitedRenders++
      if (p.waitedRenders >= p.entry.observe!.turns) {
        promoted.push(p.entry) // 挂起不等于丢弃:max-wait 到期必须投递
      } else {
        stillPending.push(p)
      }
    }
    this.pendingWatch = stillPending

    // B. intake:opt-in observe 的新条目进入挂起观察（挂起态不渲染,缓存安全）。
    //    本轮刚被提前确认/到期送达的 key 不再重新挂起（避免送达轮重复入队）。
    const promotedKeys = new Set(promoted.map(e => e.key))
    const directEntries: AdvisoryEntry[] = []
    for (const e of this.entries) {
      if (e.observe && !e.immediate && e.tier !== 'constitutional' && !promotedKeys.has(e.key)) {
        const existing = this.pendingWatch.find(p => p.entry.key === e.key)
        if (existing) {
          existing.entry = e // 条件仍在:刷新内容,保留观察进度
        } else {
          this.pendingWatch.push({ entry: e, startTurn: turn, waitedRenders: 0 })
          this.ledgerDeferred++
        }
        continue
      }
      directEntries.push(e)
    }
    this.entries = directEntries

    // C. 阶段抑制推迟的条目回到竞争池（到限强制送达在 E 段判定）
    const carried = this.suppressedCarry
    this.suppressedCarry = []

    let all = [...this.alive, ...this.entries, ...promoted, ...carried.map(c => c.entry)]
    const deferralsByKey = new Map(carried.map(c => [c.entry.key, c.deferrals]))

    // ── P1b 习惯化对抗（constitutional 豁免） ──
    if (this.habituation) {
      // 静音计时按渲染周期流逝（无论该 key 本轮是否被投递）
      for (const [k, v] of this.silenceRemaining) {
        if (v <= 1) this.silenceRemaining.delete(k)
        else this.silenceRemaining.set(k, v - 1)
      }
      const droppedSilenced = new Set<string>()
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        if (e.tier === 'constitutional') {
          kept.push(e)
          continue
        }
        if (this.silenceRemaining.has(e.key)) {
          droppedSilenced.add(e.key)
          continue
        }
        const streak = this.habituation.getIgnoredStreak(e.key)
        // streak 加深才触发新静音 — 期满 probation 放行一次，采纳则 streak 清零
        if (streak >= HABITUATION_SILENCE_STREAK && streak > (this.lastSilencedStreak.get(e.key) ?? 0)) {
          this.lastSilencedStreak.set(e.key, streak)
          this.silenceRemaining.set(e.key, HABITUATION_SILENCE_RENDERS)
          droppedSilenced.add(e.key)
          continue
        }
        if (streak >= HABITUATION_ESCALATE_STREAK) {
          // 升级措辞："被忽略"这个事实本身是新信息，比原文重复更穿透习惯化
          kept.push({ ...e, content: `（此提醒已连续 ${streak} 次未见执行——若你有意跳过请在回复中说明理由）${e.content}` })
          continue
        }
        kept.push(e)
      }
      this.recordDropped(droppedSilenced)
      all = kept
    }

    // ── Lift 消费端:负 lift 自动静音（"没提醒也会做"= 纯噪音）──
    // 成熟 lift ≤ 0 → 静音 LIFT_MUTE_RENDERS 周期;期满 probation 放行一次
    // 收集新证据,之后 lift 仍 ≤0 才再静音（避免数据不更新导致永久静音）。
    // 豁免与 holdout 资格同源:constitutional / immediate / star_domain 永不静音。
    if (this.liftProvider) {
      for (const [k, v] of this.liftMuteRemaining) {
        if (v <= 1) {
          this.liftMuteRemaining.delete(k)
          this.liftProbation.add(k) // 期满 → 下次出现放行一次
        } else {
          this.liftMuteRemaining.set(k, v - 1)
        }
      }
      const droppedByLift = new Set<string>()
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        const exempt = e.tier === 'constitutional' || e.immediate === true || e.category === 'star_domain'
        if (exempt) {
          kept.push(e)
          continue
        }
        if (this.liftMuteRemaining.has(e.key)) {
          droppedByLift.add(e.key)
          continue
        }
        if (this.liftProbation.has(e.key)) {
          this.liftProbation.delete(e.key) // probation 送达,消费一次
          kept.push(e)
          continue
        }
        const lift = this.liftProvider(e.key)
        if (lift !== null && lift <= LIFT_MUTE_THRESHOLD) {
          this.liftMuteRemaining.set(e.key, LIFT_MUTE_RENDERS)
          droppedByLift.add(e.key)
          continue
        }
        kept.push(e)
      }
      this.ledgerLiftMuted += droppedByLift.size
      this.recordDropped(droppedByLift)
      all = kept
    }

    // Star-domain dedup — static entries only; situational star_domain exempt
    if (activeStarDomain) {
      const tag = `【${activeStarDomain}】`
      const isFrozenDuplicate = (e: AdvisoryEntry): boolean =>
        e.content.startsWith(tag) && e.category !== 'star_domain'
      this.recordDropped(all.filter(isFrozenDuplicate).map(e => e.key))
      all = all.filter(e => !isFrozenDuplicate(e))
    }

    // ── Phase 2 阶段抑制（category 白名单,navigator 沉默规则）──
    // 主控处于产出流时推迟锦上添花类信号;到 FLOW_SUPPRESS_MAX_DEFERRALS 强制送达。
    if (this.flowStateProvider?.()) {
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        const suppressible = !e.immediate
          && e.tier !== 'constitutional'
          && (FLOW_SUPPRESSIBLE_CATEGORIES.has(e.category) || e.tier === 'informational')
        const deferrals = deferralsByKey.get(e.key) ?? 0
        if (suppressible && deferrals < FLOW_SUPPRESS_MAX_DEFERRALS) {
          this.suppressedCarry.push({ entry: e, deferrals: deferrals + 1 })
          this.ledgerDeferred++
          continue
        }
        kept.push(e)
      }
      all = kept
    }

    // ── Phase 2 通道分流（bus 竞争前分走,不占 Top-N 预算）──
    // system-reminder:细断点,直接计送达(delivered)并出队给调用方注入消息流。
    // status:仅当 sink 存在时分流;否则回退 bus(宁可占预算不静默消失)。
    const srEntries = all.filter(e => e.channel === 'system-reminder')
    if (srEntries.length > 0) {
      all = all.filter(e => e.channel !== 'system-reminder')
      const srDeduped = new Map<string, AdvisoryEntry>()
      for (const e of srEntries) {
        const existing = srDeduped.get(e.key)
        if (!existing || e.priority > existing.priority) srDeduped.set(e.key, e)
      }
      for (const e of srDeduped.values()) {
        this.systemReminderOut.push(this.applyTone(e))
        this.ledgerRendered++
        this.delivered.push({ key: e.key, category: e.category, tier: e.tier, expect: e.expect })
      }
    }
    if (this.statusSink) {
      const statusEntries = all.filter(e => e.channel === 'status')
      if (statusEntries.length > 0) {
        all = all.filter(e => e.channel !== 'status')
        this.statusSink(statusEntries)
        this.ledgerRendered += statusEntries.length
        this.delivered.push(...statusEntries.map(e => ({ key: e.key, category: e.category, tier: e.tier, expect: e.expect })))
      }
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

    // 竞争排序:priority 主键;同 priority 时因果口径优先——成熟 lift 可用时
    // 用 lift（归一到 [0,1],0 lift = 中性 0.5,与采纳率同刻度）,否则回退
    // 历史采纳率(先验+实测)。实测有真实增益的提醒优先占预算。
    const secondaryScore = (key: string): number => {
      const lift = this.liftProvider?.(key)
      if (lift !== undefined && lift !== null) return (lift + 1) / 2
      return this.adoptionRateProvider?.(key) ?? 0.5
    }
    const compareEntries = (a: AdvisoryEntry, b: AdvisoryEntry): number => {
      if (b.priority !== a.priority) return b.priority - a.priority
      if (!this.adoptionRateProvider && !this.liftProvider) return 0
      return secondaryScore(b.key) - secondaryScore(a.key)
    }

    const catCounts = new Map<AdvisoryCategory, number>()
    const catFiltered: AdvisoryEntry[] = []
    for (const entry of [...deduped.values()].sort(compareEntries)) {
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

    // ── Holdout 反事实抽样:赢得渲染位的条目按小概率静默扣留（不渲染,照常
    // 核销 expect → shadow 桶）。资格白名单与习惯化静音豁免同构:
    // constitutional / immediate / star_domain 永不扣留;必须带 expect 谓词
    // （无谓词无法核销,扣留没有度量意义）;key 级历史资格由注入方判定。
    const heldOut: AdvisoryEntry[] = []
    if (this.holdout && this.holdout.rate > 0) {
      const rng = this.holdout.rng ?? Math.random
      for (let i = taken.length - 1; i >= 0; i--) {
        const e = taken[i]!
        const eligible = !e.immediate
          && e.tier !== 'constitutional'
          && e.category !== 'star_domain'
          && e.expect !== undefined
          && this.holdout.isEligible(e.key)
        if (eligible && rng() < this.holdout.rate) {
          heldOut.push(e)
          taken.splice(i, 1)
        }
      }
    }

    // Combine: constitutional always first, then by priority
    const sorted: AdvisoryEntry[] = [...constDeduped.values()]
    taken.sort(compareEntries)
    sorted.push(...taken)

    // 账本：本轮参与竞争但没拿到渲染位的条目（类别上限 / Top-N 截断）。
    // holdout 扣留 ≠ 丢弃（单独计 heldOut,且照常进 delivered 核销）。
    const renderedKeys = new Set(sorted.map(e => e.key))
    const heldKeys = new Set(heldOut.map(e => e.key))
    this.recordDropped([...deduped.keys()].filter(k => !renderedKeys.has(k) && !heldKeys.has(k)))
    this.ledgerRendered += sorted.length
    this.ledgerHeldOut += heldOut.length

    // P1a 核销闭环：记录实际送达的条目（含 expect 谓词），供 readback 追踪
    this.delivered.push(...sorted.map(e => ({
      key: e.key,
      category: e.category,
      tier: e.tier,
      expect: e.expect,
    })))
    // holdout 反事实组:扣留但照常核销（shadow 桶,自发完成率基线）
    this.delivered.push(...heldOut.map(e => ({
      key: e.key,
      category: e.category,
      tier: e.tier,
      expect: e.expect,
      shadow: true,
    })))

    if (sorted.length === 0) {
      this.entries = []
      this.alive = []
      return ''
    }

    const lines = sorted.map(e =>
      `  <entry key="${escapeXml(e.key)}" priority="${e.priority.toFixed(2)}" category="${e.category}">${escapeXml(this.applyTone(e))}</entry>`
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
    this.ledgerSubmitted = 0
    this.ledgerRendered = 0
    this.ledgerDropped = 0
    this.ledgerDroppedKeys = []
    this.delivered = []
    this.silenceRemaining.clear()
    this.lastSilencedStreak.clear()
    this.ledgerDeferred = 0
    this.ledgerRevoked = 0
    this.pendingWatch = []
    this.suppressedCarry = []
    this.systemReminderOut = []
    this.ledgerHeldOut = 0
    this.liftMuteRemaining.clear()
    this.liftProbation.clear()
    this.ledgerLiftMuted = 0
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
