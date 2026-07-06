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
 * This hook counts guard rejections session-wide (not per turn — the loop
 * spans turns) and from the 2nd offense injects a constitutional advisory that
 * explains the placeholder mechanism once, loudly, with the recovery protocol.
 *
 * Tier coordination: key='pointer-regurgitation', category='discipline',
 * priority=0.72 — above self-verify (0.58): repeated regurgitation means
 * writes are failing NOW and any other discipline advice is moot until fixed.
 */

export interface PointerRegurgitationHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Session-wide guard-rejection count before the advisory escalates. */
export const POINTER_REGURGITATION_ESCALATION_THRESHOLD = 2

export function createPointerRegurgitationHook(deps: PointerRegurgitationHookDeps): PostToolRuntimeHook {
  let offenseCount = 0

  return {
    phase: 'postTool',
    name: 'pointer-regurgitation',
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
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
    },
  }
}
