import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { POINTER_GUARD_ERROR_MARKER } from '../../tools/pointer-guard.js'

/**
 * Pointer-Regurgitation Advisory Hook — postTool escalation when the model
 * keeps echoing pointer placeholders as tool content.
 *
 * The per-tool guards (pointer-guard.ts) reject each individual offense, but
 * the 2026-07-06 word-batch report showed a model hitting the guard ~20 times
 * across write_file/edit_file/hash_edit without ever understanding why: its
 * context is saturated with placeholder examples that LOOK like valid content,
 * so each retry re-learns the wrong pattern. One inline error message per call
 * is not enough to break that loop.
 *
 * 2026-07-07（会话 519216c0 复盘）两处收紧：
 *   1. 首犯即发（threshold 2→1）。旧阈值让第一次回吐只吃 inline error——
 *      该会话 run 3 的首犯没有得到机制解释，run 4 又犯了两次才等到 advisory。
 *      机制说明没有理由等第二次犯错才给。
 *   2. 连写场景前置提醒（prophylaxis）：单会话累计 3 次成功写入后，历史里
 *      已积累多个占位符样本——这正是回吐的诱发环境（模型批量写文件时最容易
 *      模仿历史里的工具调用格式）。在首犯发生**之前**注入一次机制说明。
 *
 * Tier coordination: key='pointer-regurgitation', category='discipline',
 * priority=0.72 — above self-verify (0.58): repeated regurgitation means
 * writes are failing NOW and any other discipline advice is moot until fixed.
 * prophylaxis 是低优先级 informational（0.45）——预防性信息不与纠偏争预算。
 */

export interface PointerRegurgitationHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  addSystemReminder?: (content: string) => void
}

/** Session-wide guard-rejection count before the advisory escalates.
 *  2026-07-07: 2→1 —— 首犯即发机制解释（见文件头注释）。 */
export const POINTER_REGURGITATION_ESCALATION_THRESHOLD = 1

/** 累计成功写入次数达到此值时，前置注入一次占位符机制说明（每会话一次）。 */
export const POINTER_PROPHYLAXIS_WRITE_THRESHOLD = 3

const WRITE_CLASS_TOOLS = new Set(['write_file', 'edit_file', 'hash_edit', 'apply_patch'])

export function createPointerRegurgitationHook(deps: PointerRegurgitationHookDeps): PostToolRuntimeHook {
  let offenseCount = 0
  let successfulWrites = 0
  let prophylaxisFired = false

  return {
    phase: 'postTool',
    name: 'pointer-regurgitation',
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // ── 前置提醒：连写场景下，在首犯之前解释一次占位符机制 ──
      if (!tool.isError && WRITE_CLASS_TOOLS.has(tool.name)) {
        successfulWrites++
        if (!prophylaxisFired && offenseCount === 0 && successfulWrites >= POINTER_PROPHYLAXIS_WRITE_THRESHOLD) {
          prophylaxisFired = true
          deps.advisoryBus.submit({
            key: 'pointer-prophylaxis',
            priority: 0.45,
            category: 'discipline',
            tier: 'informational',
            content:
              '你本次会话已多次成功写入文件。提示：历史消息里已完成写入的参数会被替换成 "[file written to …]" 这类显示占位符——它们不是合法输入格式。后续每次 write_file/edit_file 都必须在参数里给出完整真实内容，不要模仿历史里的工具调用格式。',
            ttl: 2,
          })
        }
        return
      }

      if (!tool.isError) return
      if (!tool.resultContent?.includes(POINTER_GUARD_ERROR_MARKER)) return

      offenseCount++
      if (offenseCount < POINTER_REGURGITATION_ESCALATION_THRESHOLD) return

      deps.advisoryBus.submit({
        key: 'pointer-regurgitation',
        priority: 0.72,
        category: 'discipline',
        content:
          `你已 ${offenseCount} 次把指针占位符（"[file written to …]" / "[edit on …]" / "[hash_edit applied to …]"）当作真实内容传给写入工具。`
          + `机制说明：大内容写入成功后，历史消息里的参数会被替换成这种占位符——它们只是显示用的指针，从来不是合法输入，磁盘上的文件才是真实内容。`
          + `不要模仿历史里的占位符格式。恢复协议：①在参数里写出完整的真实文本（哪怕很长）；②需要旧内容时先 read_file；③若同批内容反复被拒，检查你是否在复制自己历史消息里的工具调用——那些参数已被重写，不可复用。`,
        ttl: 2,
      })
      deps.addSystemReminder?.(
        '<system-reminder>你刚才的写入调用失败，原因是你把 "[file written to …]" 这类显示占位符当成了真实内容传给参数。'
        + '这是工具历史压缩产生的指针，不是合法输入。修复：在参数中写出完整的真实内容（可以是完整代码），'
        + '不要复制历史消息里的工具调用格式。</system-reminder>',
      )
    },
  }
}
