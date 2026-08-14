/**
 * 预算耗尽后的自动续跑决策。
 *
 * worker 被 max-turns / 墙钟超时切断时，`worker-session` 已经存好断点
 * （partialResult + completedTools）并把会话消息交回 coordinator，`resumeWorkOrderId`
 * 那条链路也是通的——唯一缺的是扳机：只有主控模型自己在下一次 delegate 里写
 * `resume:'<orderId>'` 才会续跑。coordinator 那套很厚的重试阶梯（指数退避 +
 * Flash→Pro 升级）全在 `catch` 里，而预算耗尽是**正常返回**一个 blocked 结果，
 * 永远进不去。结果就是一份干到一半的 salvage 报告被当成交付。
 *
 * 这里把扳机接上：续跑就是带着上一轮的完整对话再跑一次，字节都是热前缀缓存，
 * 成本可忽略。判据放在纯函数里，便于单测穷举。
 */
import type { Usage } from '../api/types.js'
import type { WorkerResult } from './work-order.js'

/** 一个 order 最多自动续跑几次（不含首轮）。总运行次数 = 1 + 本值。
 *
 *  原值 2（稠密模型保守估计）；2026-08-01 提升至 4——DeepSeek V3/V4 的 MLA
 *  KV-cache 压缩将每轮上下文成本降至传统 attention 的约 1/5–1/10，4 轮续跑基本
 *  不会因 KV cache 膨胀导致退化。收益：减少 hard-fail（blocked），增加 partial
 *  result salvage 概率。外层 timeout 相应增大（3x → 5x）。
 *
 *  4→6（2026-08-10 桌面 starflow 会话实证）：写工预算 300→600s 后，长 shard
 *  单轮仍可能撞墙钟；续跑撞顶 "续跑 3/4 · 时间预算耗尽" 意味着改了一半的
 *  partial 被放弃。每轮续跑字节都是热前缀缓存（成本 ≈ 一轮推理），多给 2 轮
 *  续跑比让 partial 白扔更省总轮次。外层 timeout 已按 runs 放大，无硬截断风险。 */
export const MAX_BUDGET_CONTINUATIONS = 6

/**
 * 停滞判据：一轮预算耗尽时，工具调用数 ≤ 此值的轮次视为「产出停滞」——墙钟基本
 * 花在等首字节/空转而非干活，原样续跑只会再烧一轮墙钟（2026-08-07 议事会分析：
 * 文档实测活跃轮 tool 31–47，远高于此值；600s 里 ≤3 次工具调用即「等首字节空转」）。
 */
export const STALL_TOOL_CALL_THRESHOLD = 3

/**
 * 一次 hands 会话里，首轮之外最多再跑几次 agent。**续跑、JSON 解析修复、写闸门
 * 修复共用这一本账**——三条路径都可能在同一次会话里触发，各记各的会叠乘成
 * 「N 续跑 × 2 解析修复 + 1 闸门修复」。共用总账把最坏情况钉死在 1 + (MAX+1) = MAX+2 轮。
 */
export const MAX_HANDS_EXTRA_RUNS = MAX_BUDGET_CONTINUATIONS + 1

/** 总账里给写闸门修复留的额度——续跑不许把它吃光，否则闸门失败时无人可修。 */
export const HANDS_GATE_REPAIR_RESERVE = 1

/** 只有「预算不够」才续跑。其余失败原因换个跑法也是同样结果。 */
const CONTINUABLE_REASONS = new Set(['max_turns', 'timeout'])

export interface ContinuationInput {
  result: WorkerResult
  /** 已经续跑过几次（首轮结束时为 0）。 */
  attempt: number
  /** 父信号或 order controller 是否已经断开。 */
  aborted: boolean
  /** 写工（hands 角色）。 */
  isWrite: boolean
  /** 写工是否跑在共享 worktree 里。 */
  sharedWorktree: boolean
  /** 上一轮是否交回了会话消息——续跑靠它承接上下文。 */
  hasSessionMessages: boolean
  /** 上一轮的产出度量。缺席时不判（旧调用点）。
   *
   *  `waitingFirstByteMs` / `ttftSamples` 目前**只采集不判据**：绝对阈值需要健康
   *  环境下的基线，而现有样本全部采自一次性能风暴期间（席位平均每次工具调用间隔
   *  15–36s，非席位中位数 10.3s），拿它标定会把病态固化成标准。等积累到干净基线
   *  再决定判据形态——大概率是「相对该 profile 历史中位数退化 N 倍」而非绝对秒数。 */
  productivity?: { toolCalls: number; waitingFirstByteMs?: number; ttftSamples?: number }
}

export type ContinuationDecision =
  | { readonly proceed: true; readonly reason: 'max_turns' | 'timeout' }
  | { readonly proceed: false; readonly skipReason: string }

/**
 * coordinator 层只管只读工。**写工的续跑交给 `runHandsSession` 在工作树内部做**
 * （Wave 7）——那里 worktree 还活着、上一轮的改动还在，续跑才是「接着干」而不是
 * 「基于不存在的前置改动重做」。在这一层再续一次就是双重续跑：
 *
 * - **隔离 worktree**：coordinator 拿到结果时 worktree 连同分支已在 `runHandsSession`
 *   的 finally 里销毁，这里起的新一轮只会拿到空目录。
 * - **共享 worktree**：改动落在控制器 cwd 里不会丢，但绕过 `runHands` 直接
 *   `runWorker` 会静默跳过写闸门（scoped typecheck + 有界修复）与 diff 收集。
 */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const reason = input.result.failureReason
  if (!reason || !CONTINUABLE_REASONS.has(reason)) {
    return { proceed: false, skipReason: `failureReason=${reason ?? 'none'} 不属于可续跑原因（注意：stalled 是预算耗尽的空跑子类，同样不续跑——空跑原样续跑只会再烧一轮预算）` }
  }
  if (input.aborted) {
    return { proceed: false, skipReason: '调用方已中止——用户按了停，不要自作主张接着跑' }
  }
  if (input.attempt >= MAX_BUDGET_CONTINUATIONS) {
    return { proceed: false, skipReason: `已续跑 ${input.attempt} 次，达到上限` }
  }
  if (!input.hasSessionMessages) {
    return { proceed: false, skipReason: '上一轮没有会话消息可承接，续跑等于从零重来' }
  }
  // 写工的架构边界排在停滞判据之前：写工在这一层本来就不续（无论产出多少），
  // 让停滞判据先返回会把 skipReason 说成「产出停滞」，把排查引向模型速度而不是
  // 「这层不该续」这个真实原因。
  if (input.isWrite) {
    const mode = input.sharedWorktree ? '共享 worktree' : '隔离 worktree'
    return { proceed: false, skipReason: `${mode}写工：续跑由 hands-session 在工作树内处理，coordinator 层不重复续` }
  }
  if (input.productivity && reason === 'timeout' && input.productivity.toolCalls <= STALL_TOOL_CALL_THRESHOLD) {
    // 只拦墙钟空转（timeout）：600s 里 ≤3 次工具调用 = 等首字节，原样续跑只会再烧
    // 一轮墙钟。max_turns 撞顶时调用少是正常形态（轮次本就少），不拦——否则集成测试
    // 里 2 轮撞顶的 mock worker 会被误判停滞（2026-08-07 分析文档点名的是「墙钟被
    // 首字节等待吃光」，不是轮次预算耗尽）。
    return { proceed: false, skipReason: `上轮产出停滞（仅 ${input.productivity.toolCalls} 次工具调用即耗尽墙钟预算）——原样续跑只会再烧一轮墙钟` }
  }
  return { proceed: true, reason: reason as 'max_turns' | 'timeout' }
}

export interface HandsContinuationInput {
  result: WorkerResult
  /** 已经续跑过几次（首轮结束时为 0）。 */
  attempt: number
  /** 本次 hands 会话里首轮之外已经用掉的 agent 轮次（与解析修复、闸门修复共用总账）。 */
  extraRunsUsed: number
  /** 父信号断开或 API 报错——不得再续。 */
  aborted: boolean
}

/**
 * 写工在 worktree 内续跑的判据。与只读工共用 `MAX_BUDGET_CONTINUATIONS`，另外受
 * `MAX_HANDS_EXTRA_RUNS` 总账约束并给写闸门修复留额度。
 *
 * 为什么写工必须续：写闸门的触发条件含 `status !== 'blocked'`，而预算耗尽返回的
 * 正是 blocked——不续的话写工一旦撞预算连闸门都不过，改动躺在工作树里没人验。
 */
export function decideHandsContinuation(input: HandsContinuationInput): ContinuationDecision {
  const reason = input.result.failureReason
  if (!reason || !CONTINUABLE_REASONS.has(reason)) {
    return { proceed: false, skipReason: `failureReason=${reason ?? 'none'} 不属于可续跑原因（注意：stalled 是预算耗尽的空跑子类，同样不续跑——空跑原样续跑只会再烧一轮预算）` }
  }
  if (input.aborted) {
    return { proceed: false, skipReason: '调用方已中止——用户按了停，不要自作主张接着跑' }
  }
  if (input.attempt >= MAX_BUDGET_CONTINUATIONS) {
    return { proceed: false, skipReason: `已续跑 ${input.attempt} 次，达到上限` }
  }
  if (input.extraRunsUsed >= MAX_HANDS_EXTRA_RUNS - HANDS_GATE_REPAIR_RESERVE) {
    return { proceed: false, skipReason: `本次 hands 会话已额外跑 ${input.extraRunsUsed} 轮，剩余额度留给写闸门修复` }
  }
  return { proceed: true, reason: reason as 'max_turns' | 'timeout' }
}

/** 续跑轮的 objective——告诉它这是接着干，不是重来。 */
export function buildContinuationObjective(
  originalObjective: string,
  reason: 'max_turns' | 'timeout',
  attempt: number,
): string {
  const cause = reason === 'max_turns'
    ? '上一轮用尽了轮次预算，没能产出终局报告'
    : '上一轮用尽了时间预算，没能产出终局报告'
  return [
    `继续未完成的任务（第 ${attempt} 次续跑）。${cause}——你的完整对话历史就在上面，已经做过的工作不要重做。`,
    '先花一轮盘点：已经查清/改完了什么，还差什么。然后只补差的部分，尽快产出终局 JSON 报告。',
    '如果这一轮又要用尽预算，宁可提前收敛成一份诚实的部分报告，也不要再次被硬切断。',
    '',
    `原始目标：${originalObjective}`,
  ].join('\n')
}

/** 累加续跑各轮的 token 用量——只加两侧都可能缺的数值字段，缺项按 0 计。 */
export function mergeUsage(
  a: Usage | Partial<Usage> | undefined,
  b: Usage | Partial<Usage> | undefined,
): Usage | Partial<Usage> | undefined {
  if (!a) return b
  if (!b) return a
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof Usage>)
  const merged: Partial<Usage> = {}
  for (const key of keys) {
    const left = a[key]
    const right = b[key]
    if (typeof left === 'number' || typeof right === 'number') {
      merged[key] = (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0)
    }
  }
  return merged
}

/** 在续跑产出的结果上留痕，让主控知道这份报告经过几轮才落地。 */
export function markContinued(result: WorkerResult, attempts: number, reason: 'max_turns' | 'timeout'): WorkerResult {
  const note = `budget-continuation: 首轮因${reason === 'max_turns' ? '轮次' : '时间'}预算耗尽被切断，自动续跑 ${attempts} 次后产出本报告`
  return result.risks.includes(note) ? result : { ...result, risks: [...result.risks, note] }
}
