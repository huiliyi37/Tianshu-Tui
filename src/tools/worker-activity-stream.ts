import type { WorkerActivityEvent } from '../agent/coordinator.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/**
 * T9 P3 实时上行: convert raw worker activity events into a bounded stream of
 * progress lines for the live tool card. Token deltas are collapsed (first
 * delta announces streaming, then a counter line every `textEvery` deltas);
 * tool uses are always emitted — they are the meaningful progress beats.
 */
export function createActivityStreamer(
  emit: (line: string) => void,
  opts?: { textEvery?: number },
): (event: WorkerActivityEvent) => void {
  const textEvery = opts?.textEvery ?? 400
  const textCounts = new Map<string, number>()

  return (event: WorkerActivityEvent) => {
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      emit(`  ↳ [${label}] ⚙ ${event.detail ?? 'tool'}\n`)
      return
    }
    if (event.kind === 'tool_result') return
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
