import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { SrClass } from '../context.js'

/**
 * Wrapup-Anxiety Guard（焦虑收尾对冲）— postTurn hook。
 *
 * 失败模式：模型基于"习惯性上下文焦虑"（而非物理事实）建议收尾/开新会话。
 * 实例（session 20b9714e）：mirror 显示 ctx="10%·1M" 时输出"剩余 T3-T6
 * 交给新会话"——判断与实测数据相差一个数量级。
 *
 * 机制：正则匹配本 turn 流式文本中的收尾话术（中英文直接 + 间接措辞组），
 * 命中后与实测 ctxRatio 对照，三段阈值：
 *   - ratio < 0.5     → 注入硬数据反驳 advisory（话术不基于物理事实）
 *   - 0.5 ≤ ratio < 0.7 → 灰区，不注入（既不反驳也不附和——此区间焦虑
 *                        话术可能确实有道理，反驳是 false positive 风险区）
 *   - ratio ≥ 0.7     → 不触发（context-pressure hook 的收束建议在此区间合法）
 *
 * 阈值 0.5 若实测偏保守，由 vitals-lite 遥测回放校准，不在 v1 猜。
 * 反驳双通道投递（对齐 pointer-regurgitation 的必达修法）：advisory 留痕遥测，
 * 反驳正文经 addSystemReminder 走 functional 通道（不限流——discipline 每轮
 * 限 1 条，易被更高优先级条目挤掉；本 hook 自带 cooldown 闩锁，满足
 * functional 通道"调用方自带闩锁"前提）。
 */

export interface WrapupAnxietyGuardHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 本 turn 的流式 assistant 文本（与 dedup-guard 同款 getter）。 */
  getStreamedText: () => string
  getEstimatedTokens: () => number
  getContextWindow: () => number
  /** 必达纠偏通道（functional 不限流）。缺席时退化为仅 advisory。 */
  addSystemReminder?: (content: string, cls?: SrClass) => void
  /** 反驳阈值：ratio 低于此值时话术视为不基于事实。默认 0.5。 */
  refuteBelowRatio?: number
  /** 触发冷却（轮），默认 5。 */
  cooldownTurns?: number
}

/** 收尾/新会话话术——直接措辞（中文）。 */
const DIRECT_PATTERNS: RegExp[] = [
  /上下文(紧张|快满|压力|不足|有限|吃紧|不多|快用完|即将用尽)/,
  /建议(开|开启|新建)?新会话/,
  /先交付这部分/,
  /受限于篇幅/,
]

/** 直接措辞（英文，2026-08-29 用户实锤后补——此前英文零覆盖，守卫不触发）。 */
const DIRECT_EN_PATTERNS: RegExp[] = [
  /context (window )?(is )?(running )?(low|limited|almost full|nearly full|running out|nearly exhausted)/i,
  /start(ing)? a (fresh|new) (session|chat|conversation)/i,
  /continue (this )?in a new (session|chat|conversation)/i,
  /due to (the )?context (limit|length|window|constraints?)/i,
  /(move|moving|hand|handing) (the )?(rest|remaining|this|it) (over )?to a new (session|chat|conversation)/i,
]

/** 间接措辞（天权补充，来自实际 session 证据"剩余 T3-T6 交给新会话"）。
 *  [^。]* 限制在单句内匹配，防跨句误配。 */
const INDIRECT_PATTERNS: RegExp[] = [
  /(剩余|余下|剩下)[^。\n]*新会话/,
  /新会话[^。\n]*(继续|实施|接手|完成)/,
  /交给新会话/,
  /留给新会话/,
  /(新开|另起|另开|重开)(一?个)?(新)?(会话|对话)/,
  /(对话|会话)(历史)?(太|过|比较)长(了)?/,
  /tokens?\s*(快)?(要)?(用完|耗尽|不够|不足)/i,
]

/** 检测收尾话术。返回命中的第一个片段（用于 advisory 引用），未命中返回 null。 */
export function detectWrapupPhrase(text: string): string | null {
  for (const re of [...DIRECT_PATTERNS, ...DIRECT_EN_PATTERNS, ...INDIRECT_PATTERNS]) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

export function createWrapupAnxietyGuardHook(deps: WrapupAnxietyGuardHookDeps): PostTurnRuntimeHook {
  const refuteBelow = deps.refuteBelowRatio ?? 0.5
  const cooldown = deps.cooldownTurns ?? 5
  let lastFiredTurn = -Infinity

  return {
    phase: 'postTurn',
    name: 'wrapup-anxiety-guard',
    run(ctx: RuntimeHookContext): void {
      const text = deps.getStreamedText()
      if (!text || text.length < 20) return

      const phrase = detectWrapupPhrase(text)
      if (!phrase) return

      const estimated = deps.getEstimatedTokens()
      const window = deps.getContextWindow()
      if (window <= 0 || estimated <= 0) return

      const ratio = estimated / window
      // 三段阈值：只在 ratio < refuteBelow 反驳。灰区（refuteBelow ~ 0.7）
      // 与高压区（≥0.7，context-pressure 已合法建议收束）都不注入。
      if (ratio >= refuteBelow) return

      const turn = ctx.snapshot.turn
      if (turn - lastFiredTurn < cooldown) return
      lastFiredTurn = turn

      const pct = Math.round(ratio * 100)
      const windowLabel = window >= 1_000_000
        ? `${Math.round(window / 1_000_000)}M`
        : `${Math.round(window / 1000)}K`
      const refutation = `你刚提到"${phrase.slice(0, 40)}"，但实测上下文使用率仅 ${pct}%（窗口 ${windowLabel}）——该判断不基于物理事实，是习惯性焦虑。上下文余量充足，继续当前任务；需要确认时用 session_vitals 取证，以实测为准。`
      deps.advisoryBus.submit({
        key: 'wrapup-anxiety-guard',
        priority: 0.65,
        tier: 'operational',
        category: 'discipline',
        content: refutation,
        ttl: 1,
      })
      // 必达通道（functional 不限流）：discipline 每轮限 1 条，反驳可能被同轮
      // 更高优先级条目挤掉而永不落地；cooldown 闩锁保证此路自身不刷屏。
      deps.addSystemReminder?.(`<system-reminder>${refutation}</system-reminder>`, 'functional')
    },
  }
}
