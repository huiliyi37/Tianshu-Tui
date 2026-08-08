/**
 * 跨波反馈回执 — 把上一波的验收结论压成几条约束，注入下一波 worker 的工单。
 *
 * 为什么需要（2026-08-05 闭环审计）：
 *   team 的「执行 → 验收 → 反馈 → 下一波」回路在最后一环是断的。波间硬门禁
 *   （wave-gate）、scope-health、worker failures 全都只写进 tool 输出给**主控
 *   模型**看；`waveToRequests` 构造下一波 DelegationRequest 时用的仍是计划里
 *   的原始 objective 加静态 planConstraints。下一波 worker 对上一波发生过什么
 *   一无所知，唯一能感知的是共享工作树上的 git 改动。
 *
 *   结果是：上一波因 typecheck 失败被拦、或某个任务超时未完成，下一波 worker
 *   照着原计划继续推进，往往在同一个坑上再摔一次——除非主控模型读完摘要后
 *   手动改计划或 steer。
 *
 * 设计约束：
 *   - **体量**：constraints 在 worker prompt 里是 ` | ` 拼接的单行
 *     （worker-prompts.ts:256），且 worker 首轮前缀缓存命中率本就偏低
 *     （实测 turn0 仅 39.8%）。所以逐条限长、总条数封顶，宁可少说不可刷屏。
 *   - **信息量**：只报没通过的。passed 的 worker 不占额度——下一波能从共享
 *     工作树看到它的产物，重复叙述只是噪音。
 *   - **确定性**：同样的输入产出同样的字节（截断按字符数、顺序按输入顺序），
 *     不引入时间戳/随机序，避免同一条建议在轮间字节抖动。
 *   - **fail-open**：无反馈时返回空数组，调用方不注入任何字段，行为与改动前
 *     逐位一致。
 */
import type { WorkerResult } from './work-order.js'

/** 最多注入的回执条数——超出部分丢弃并在末条标注省略数 */
export const MAX_FEEDBACK_ENTRIES = 5
/** 单条回执的最大字符数 */
export const MAX_FEEDBACK_ENTRY_CHARS = 90
/** scope 泄漏最多点名的文件数 */
export const MAX_LEAKED_FILES = 3

export interface PriorWaveFeedbackInput {
  /** 上一波的 worker 结果（含跨波合成的 blocked/skipped） */
  priorResults?: readonly WorkerResult[]
  /** 上一波波间门禁：仅在未通过时提供失败项摘要 */
  waveGateFailures?: readonly string[]
  /** 上一波检测到的计划外改动文件（scope-health leaked） */
  scopeLeaks?: readonly string[]
}

/** `team:T1` / `wo_abc:team:T1` → `T1`；无冒号原样返回 */
function taskIdOf(workOrderId: string): string {
  const i = workOrderId.lastIndexOf(':')
  return i >= 0 ? workOrderId.slice(i + 1) : workOrderId
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 未通过 worker 的一句话归因。优先级：机器可判的 failureReason > 门禁写进
 * risks 的判词 > 模型自述 summary。三者皆空时只报状态，不编造原因。
 */
function reasonOf(result: WorkerResult): string {
  if (result.failureReason) return result.failureReason
  const risk = result.risks?.[0]
  if (typeof risk === 'string' && risk.trim()) return risk
  if (result.summary?.trim()) return result.summary
  return ''
}

/**
 * 生成注入下一波工单的回执。返回空数组表示上一波没有需要下传的坏消息。
 */
export function buildPriorWaveFeedback(input: PriorWaveFeedbackInput): string[] {
  const out: string[] = []

  const failed = (input.priorResults ?? []).filter(r => r.status !== 'passed')
  for (const r of failed) {
    const reason = reasonOf(r)
    const head = `上一波 ${taskIdOf(r.workOrderId)} ${r.status}`
    out.push(clip(reason ? `${head}：${reason}` : head, MAX_FEEDBACK_ENTRY_CHARS))
  }

  const gateFailures = (input.waveGateFailures ?? []).filter(f => f.trim())
  if (gateFailures.length > 0) {
    out.push(clip(`上一波门禁未过：${gateFailures.join('；')}`, MAX_FEEDBACK_ENTRY_CHARS))
  }

  const leaks = (input.scopeLeaks ?? []).filter(f => f.trim())
  if (leaks.length > 0) {
    const named = leaks.slice(0, MAX_LEAKED_FILES).join('、')
    const more = leaks.length > MAX_LEAKED_FILES ? ` 等 ${leaks.length} 处` : ''
    out.push(clip(`上一波有计划外改动：${named}${more}——本波勿扩大范围`, MAX_FEEDBACK_ENTRY_CHARS))
  }

  if (out.length <= MAX_FEEDBACK_ENTRIES) return out
  const kept = out.slice(0, MAX_FEEDBACK_ENTRIES - 1)
  kept.push(`（另有 ${out.length - kept.length} 条上一波回执已省略）`)
  return kept
}
