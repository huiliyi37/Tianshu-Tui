import type { WorkerActivityEvent } from '../agent/coordinator.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/**
 * T9 P3 实时上行: convert raw worker activity events into a bounded stream of
 * progress lines for the live tool card.
 *
 * B3 improvements:
 * - tool_use and tool_result are always emitted (one line each)
 * - text heartbeat threshold reduced from 400 → 150 deltas for finer-grained feedback
 * - tool_result no longer silently dropped
 */
export function createActivityStreamer(
  emit: (line: string) => void,
  opts?: { textEvery?: number },
): (event: WorkerActivityEvent) => void {
  const textEvery = opts?.textEvery ?? 150
  const textCounts = new Map<string, number>()

  return (event: WorkerActivityEvent) => {
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      const toolDetail = event.detail ? ` ${event.detail.slice(0, 60)}` : ''
      emit(`  ↳ [${label}] ⚙${toolDetail}\n`)
      return
    }
    if (event.kind === 'tool_result') {
      const resultHint = event.detail ? ` (${event.detail.slice(0, 40)})` : ''
      emit(`  ↳ [${label}] ✓ done${resultHint}\n`)
      return
    }
    // text / thinking deltas: collapse into sparse heartbeat lines.
    const n = (textCounts.get(event.workOrderId) ?? 0) + 1
    textCounts.set(event.workOrderId, n)
    if (n === 1) {
      emit(`  ↳ [${label}] ✎ 输出中…\n`)
    } else if (n % textEvery === 0) {
      emit(`  ↳ [${label}] ✎ …${n} deltas\n`)
    }
  }
}
