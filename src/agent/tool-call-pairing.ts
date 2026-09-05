/**
 * 工具调用配对收集器（loop.ts 三处共用的单趟遍历）：
 * heal 预扫（healOrphansBeforeReliabilityDecision）/ detectPendingTools /
 * computeSessionIntegrity 曾各自重复实现同一收集循环——口径漂移风险随
 * 复制次数累积（2026-09-05 审查 LOW），收敛到此。
 *
 * 孤儿有两个方向，语义不同：
 * - call 无 result（孤儿调用）：会话恢复时会让模型误以为工具仍在飞，
 *   触发冻结链——heal 的愈合对象。
 * - result 无 call（孤儿结果）：只是统计口径（rewind/裁剪的残留），
 *   不触发冻结，不在愈合范围。
 */

/** 配对所需的最小消息形状（结构子类型，不耦合 OaiMessage 全形）。 */
export interface PairingMessage {
  role: string
  tool_calls?: readonly { id?: string }[]
  tool_call_id?: string
}

export interface ToolCallPairing {
  /** assistant 消息里全部 tool_calls 的 id 集 */
  toolCallIds: Set<string>
  /** tool 消息里全部 tool_call_id 集 */
  toolResultIds: Set<string>
}

export function collectToolCallPairing(msgs: readonly PairingMessage[]): ToolCallPairing {
  const toolCallIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) toolCallIds.add(tc.id)
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      toolResultIds.add(m.tool_call_id)
    }
  }
  return { toolCallIds, toolResultIds }
}

/** 孤儿调用（call 无 result）——heal/detect 的判定口径。 */
export function hasOrphanToolCalls(pairing: ToolCallPairing): boolean {
  for (const id of pairing.toolCallIds) {
    if (!pairing.toolResultIds.has(id)) return true
  }
  return false
}
