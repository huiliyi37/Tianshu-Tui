/**
 * 星域个性化 advisory 措辞适配（2026-07-07，会话 519216c0 复盘产物）。
 *
 * 背景：天权域（称量者）的认知场自带反驳与质疑——外部信号以命令式送达时
 * （"换个角度看问题""请先验证"），域的第一反应是称量并驳回它，而不是执行。
 * 该会话 68 条 advisory 送达 0 条采纳，模型在正确路线上持续推进，通用
 * 纠偏措辞对它是纯噪音。
 *
 * 处方不是加大剂量，是换语言：把信号翻译成目标域听得进的形态。对天权，
 * 这意味着援引它自己的宪法——"没有沉默的秤"（tianquan systemPromptSuffix）：
 * 信号作为待称量的证据呈现，且要求显式裁决（采纳→行动 / 驳回→给出更强
 * 证据），把"静默忽略"从可选项里移除。域的质疑本能由此从对抗信号变成
 * 消化信号的通道。
 *
 * 应用位置：AdvisoryBus 渲染出口（bus 附录块 + system-reminder 通道），
 * 每轮重建、不进 frozen 前缀——缓存安全。
 *
 * 豁免：
 *   - constitutional tier：安全底线保持命令式，不进入称量协商。
 *   - encouragement：正向反馈无需裁决协议。
 *   - 已带 【天权】 标签的内容：域自身的声音不再包装（且静态同名条目
 *     本就会被 render 的星域去重过滤掉）。
 *
 * 扩展方式：其他域按需在 DOMAIN_TONES 增加词条——键是 StarDomainId，
 * 值是内容变换函数。没有词条的域保持原文（恒等）。
 */
import type { AdvisoryCategory, AdvisoryTier } from './advisory-bus.js'

export interface AdvisoryToneMeta {
  key: string
  category: AdvisoryCategory
  tier?: AdvisoryTier
}

/** 不参与措辞适配的类别（正向反馈不需要裁决协议）。 */
const TONE_EXEMPT_CATEGORIES: ReadonlySet<AdvisoryCategory> = new Set(['encouragement'])

/** 天权：信号 → 待称量证据 + 显式裁决协议（援引"没有沉默的秤"）。 */
function tianquanTone(content: string): string {
  if (content.includes('【天权】')) return content
  return `${content}〔此信号供你称量，不是指令：采纳→据此行动；驳回→给出更强证据（文件:行号）。没有沉默的秤——二者必居其一，不可无声跳过。〕`
}

const DOMAIN_TONES: Record<string, (content: string) => string> = {
  tianquan: tianquanTone,
}

/**
 * 按当前星域适配一条 advisory 的措辞。domainId 为空（starSoul 关闭 /
 * 域未激活）或域无词条时恒等返回。
 */
export function applyDomainAdvisoryTone(
  domainId: string | null | undefined,
  content: string,
  meta: AdvisoryToneMeta,
): string {
  if (!domainId) return content
  const tone = DOMAIN_TONES[domainId]
  if (!tone) return content
  if (meta.tier === 'constitutional') return content
  if (TONE_EXEMPT_CATEGORIES.has(meta.category)) return content
  return tone(content)
}
