/**
 * Star Domain Voice — tone converter for partner dialogue.
 *
 * Each star domain has a distinct personality that shines through
 * its word choice. This module provides pure functions to apply
 * domain-specific tone to radio messages.
 *
 * Design: harness-layer template replacement — no LLM overhead.
 * A domain's voice is not an add-on; it's the message itself.
 */

export type DomainVoiceId = 'tianshu' | 'pojun' | 'tianfu' | 'tianliang' | 'tianquan' | 'tianji' | 'tianxuan' | null

// ---------------------------------------------------------------------------
// Domain tone tables
// ---------------------------------------------------------------------------

const DOMAIN_NAMES: Record<string, string> = {
  tianshu: '天枢',
  pojun: '破军',
  tianfu: '天府',
  tianliang: '天梁',
}

/**
 * Tone conversion table: [match phrase, replacement] pairs.
 * Longer/more specific phrases tested first to avoid partial matches.
 */
const DOMAIN_TONE: Record<string, Array<[string, string]>> = {
  tianshu: [
    // 天枢 — central pivot, orchestrator. Grand coordinator who sees the whole board.
    ['准备制定方案', '全局已明，调度方案就绪'],
    ['开始修改', '调度已定，开始执行'],
    ['正在修复', '定位病灶，统筹修复'],
    ['代码修改完成', '调度完毕，各路已归位'],
    ['测试全部通过', '各路验收通过，全局无误'],
    ['运行测试验证', '验收各路交付'],
    ['准备交付结果', '全局一致，统合交付'],
    ['收到任务，开始分析', '收到，先看全貌'],
    ['可能遇到困难', '调度受阻，重新评估全局路径'],
    ['接近完成', '各路收尾中'],
    ['继续执行中', '统筹推进中'],
    ['最后验证中', '各路终验中'],
    ['正在分析', '统览全局中'],
    ['测一下', '核验一下'],
  ],
  pojun: [
    // 破军 — bold, brash, unafraid. A hotshot warrior.
    ['准备制定方案', '脑子已经热了，盘一下'],
    ['开始修改', '开打'],
    ['正在修复', '锤它'],
    ['代码修改完成', '改完了，帅'],
    ['测试全部通过', '全过！'],
    ['运行测试验证', '跑个测试验验成色'],
    ['准备交付结果', '搞定，交活'],
    ['收到任务，开始分析', '收到，开搞'],
    ['可能遇到困难', '卡了一下，小场面'],
    ['接近完成', '快了快了'],
    ['继续执行中', '继续冲'],
    ['最后验证中', '最后扫一眼'],
    ['正在分析', '捋一下'],
    ['测一下', '跑跑看'],
  ],
  tianfu: [
    // 天府 — cautious, protective, steward. A guardian who says no.
    ['准备制定方案', '评估完毕，谋定后动'],
    ['开始修改', '善守者藏于九地之下，现在出手'],
    ['正在修复', '定位根因，精准修复'],
    ['代码修改完成', '修改完毕，准备审验'],
    ['测试全部通过', '验证通过，防线稳固'],
    ['运行测试验证', '开始全面验证，不容有失'],
    ['准备交付结果', '验证已过，安全交付'],
    ['收到任务，开始分析', '收到，先评估风险边界'],
    ['可能遇到困难', '遇到边界情况，正在评估影响面'],
    ['接近完成', '收尾检查中'],
    ['继续执行中', '稳步推进中'],
    ['最后验证中', '做最后一道安全检查'],
    ['正在分析', '审慎评估中'],
    ['测一下', '验证一下'],
  ],
  tianliang: [
    // 天梁 — methodical, precise, committed. An architect who delivers.
    ['准备制定方案', '方案已对齐 spec，逐步推进'],
    ['开始修改', '按计划逐步实现'],
    ['正在修复', '定位根因，逐项修复'],
    ['代码修改完成', '实现完成，准备逐项验证'],
    ['测试全部通过', '全部验收通过 ✓'],
    ['运行测试验证', '按 spec 逐项跑测试'],
    ['准备交付结果', '验收通过，按标准交付'],
    ['收到任务，开始分析', '收到，逐条拆解需求'],
    ['可能遇到困难', '当前步骤复杂度超预期，重新评估工期'],
    ['接近完成', '进入交付前最终检查'],
    ['继续执行中', '按步骤继续推进'],
    ['最后验证中', '逐项核对交付标准'],
    ['正在分析', '逐条分析中'],
    ['测一下', '验收一下'],
  ],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply domain voice to a radio message.
 *
 * Does two things:
 * 1. Replaces the `[天枢]` prefix with `[天枢·{domainName}]`
 * 2. Replaces key phrases with domain-specific expressions
 *
 * If domainId is null or unrecognized, returns the message unchanged.
 *
 * Pure function — no side effects, no I/O.
 */
export function applyDomainVoice(message: string, domainId: DomainVoiceId): string {
  if (!domainId || !(domainId in DOMAIN_TONE)) return message

  const domainName = DOMAIN_NAMES[domainId]
  if (!domainName) return message

  // 1. Swap prefix: [天枢] → [天枢·破军]
  let result = message.replace(/^\[天枢\]/, `[天枢·${domainName}]`)

  // 2. Apply tone replacements — longer phrases first to avoid
  //    partial matching (e.g. "测试全部通过" before "测试")
  const table = DOMAIN_TONE[domainId]!
  for (const [phrase, replacement] of table) {
    result = result.replaceAll(phrase, replacement)
  }

  return result
}

/**
 * Get the domain prefix string (e.g. "[天枢·破军]").
 * Returns "[天枢]" when domainId is null.
 */
export function domainPrefix(domainId: DomainVoiceId): string {
  if (!domainId || !(domainId in DOMAIN_NAMES)) return '[天枢]'
  return `[天枢·${DOMAIN_NAMES[domainId]}]`
}
