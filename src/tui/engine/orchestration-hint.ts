/**
 * 协同建议（orchestration hint）——在输入时本地检测「这活适合派蜂群」，
 * 于输入框上方给出 /team /scout /council 建议行。零模型调用、零网络，纯文本启发式。
 *
 * 背景：多代理协同是 TUI 最难被发现的强项——命令名（scout/team/council）对新用户
 * 无自明性，裸 / 核心层与 /help 只能等用户自己撞上。本模块把发现性前置到「需要的
 * 时刻」：用户正在输入一个多模块/并列结构任务时，提交前看到一次可采纳（Tab）、
 * 可关闭（Esc）的建议。
 *
 * 设计纪律：
 * - 宁缺勿滥：≥2 个信号才触发；纯疑问句（?/？ 收尾且无改动动词）不触发。
 * - 频率帽：每会话至多 MAX_SHOWS 次；Esc 或 Tab 采纳后本会话彻底关闭。
 * - 不打断：slash 输入（/ 开头）、plan/ask 模式、agent 流式中不触发。
 * - 检测是纯函数（微秒级），onChange 同步调用，无需 debounce/定时器。
 */

import { color } from './ansi.js'
import type { RivetTheme } from '../theme.js'

/** 每会话提示次数上限。 */
export const ORCHESTRATION_HINT_MAX_SHOWS = 2

/** 开关解析：env（RIVET_ORCHESTRATION_HINT=0/off/false）优先，其次 ui.orchestrationHint 配置。默认开。 */
export function resolveOrchestrationHintEnabled(envRaw: string | undefined, uiFlag: boolean | undefined): boolean {
  return !/^(0|off|false)$/i.test((envRaw ?? '').trim()) && uiFlag !== false
}

/** 信号 1：并列/序列连接词。 */
const PARALLEL_RE = /同时|并且|分别|以及|然后|并行|一起|顺便|同时再/
/** 信号 2 组件：改动类动词与验证/交付类词共现（多阶段任务形态）。 */
const ACTION_RE = /重构|实现|新增|添加|修复|优化|迁移|拆分|改造|落地/
const ACTION_RE_G = new RegExp(ACTION_RE.source, 'g')
const VERIFY_RE = /测试|文档|验证|审查|评审|review|部署|发布|交付/
/** 信号 3：@file:/@folder: 引用 ≥2（用户自己在指认多个模块）。 */
const MENTION_RE_G = /@(?:file|folder):/g
/** 信号 4 组件：显式多任务枚举（1. 2. / ①②③ 分段）。 */
const ENUM_RE = /(?:^|\n)\s*(?:\d+[.、]|[①-⑨])/
/** 长文本多任务的下限长度（字符）。 */
const LONG_MULTI_MIN = 120

export interface OrchestrationFit {
  hit: boolean
  /** 命中的信号名（调试用，不上屏）。 */
  signals: string[]
}

/**
 * 检测任务文本的协同适配度。≥2 信号才算命中（单信号误报率太高——
 * 「以及」出现在大量普通句子里）。
 */
export function detectOrchestrationFit(text: string): OrchestrationFit {
  const signals: string[] = []
  const t = text.trim()
  if (t.length === 0) return { hit: false, signals }
  // 纯疑问句：问答不是施工，不建议协同
  if (/[?？]\s*$/.test(t) && !ACTION_RE.test(t)) return { hit: false, signals }

  if (PARALLEL_RE.test(t)) signals.push('parallel-words')
  if (ACTION_RE.test(t) && VERIFY_RE.test(t)) signals.push('multi-stage')
  const mentions = t.match(MENTION_RE_G)
  if (mentions !== null && mentions.length >= 2) signals.push('multi-mention')
  const actionCount = t.match(ACTION_RE_G)?.length ?? 0
  if (t.length >= LONG_MULTI_MIN && (ENUM_RE.test(t) || actionCount >= 2)) signals.push('long-multi-task')

  return { hit: signals.length >= 2, signals }
}

/** 建议行渲染（输入框上方瞬时行；ASCII 终端退化为纯文本箭头）。 */
export function formatOrchestrationHint(theme: RivetTheme, ascii: boolean): string {
  const bolt = ascii ? '>' : '⚡'
  return (
    color(`  ${bolt} `, theme.secondary) +
    color('这活可以派蜂群——', theme.secondary) +
    color('/team', theme.warning) + color(' 并行施工 · ', theme.muted) +
    color('/scout', theme.warning) + color(' 只读侦察 · ', theme.muted) +
    color('/council', theme.warning) + color(' 方案会诊', theme.muted) +
    color(' ｜ Tab 用 /team 发送 · Esc 本会话不再提示', theme.dim)
  )
}

export interface OrchestrationHintContext {
  planMode: boolean
  askMode: boolean
  streaming: boolean
}

/** 会话级建议状态：激活标记 + 频率帽 + 关闭语义。 */
export class OrchestrationHint {
  /** 建议行当前是否应显示（渲染层每帧读取）。 */
  active = false
  private shows = 0
  /** Esc / Tab 采纳后本会话关闭（不可逆——用户已经学会了或明确不要）。 */
  private closed = false

  constructor(private readonly enabled: boolean) {}

  /**
   * 输入变化时评估（onChange 同步调用，纯函数微秒级，无需 debounce）。
   * @returns active 是否翻转（供调用方决定是否触发重渲染）。
   */
  evaluate(text: string, ctx: OrchestrationHintContext): boolean {
    const prev = this.active
    if (
      !this.enabled || this.closed ||
      this.shownCount >= ORCHESTRATION_HINT_MAX_SHOWS ||
      ctx.planMode || ctx.askMode || ctx.streaming ||
      text.startsWith('/')
    ) {
      this.active = false
    } else {
      this.active = detectOrchestrationFit(text).hit
    }
    if (this.active && !prev) this.shows++
    return prev !== this.active
  }

  /** Esc 关闭：本会话不再提示。 */
  dismiss(): void {
    this.closed = true
    this.active = false
  }

  /** Tab 采纳：本会话不再提示（用户已经会用）。 */
  adopt(): void {
    this.closed = true
    this.active = false
  }

  /** 测试观测口：本会话已提示次数。 */
  get shownCount(): number {
    return this.shows
  }
}
