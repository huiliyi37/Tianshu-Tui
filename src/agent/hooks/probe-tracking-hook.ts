/**
 * Probe-Tracking Hook — postTool 检测写操作中的探针残留，session-scoped 跟踪。
 *
 * prompt 约束（`<rule name="test-harness">` hard-gate）：
 *   临时探针（console.log、assert、debugger）修复后必须清理。残留 = 任务未完成。
 *
 * 与六个样板 hook 的关键差异：状态 session-scoped 跨轮存活。
 * 探针可能第 3 轮加、第 10 轮才 deliver——turn-scoped 跟踪表会在 turn 变更时丢失。
 * 只有"是否已告警"的 cooldown 才 turn-scoped。
 *
 * 双通道设计：
 *   1. postTool hook 记录探针到 session-scoped 表（主信道：供 deliver-task gate 消费）
 *   2. 同时 submit 一条 advisory（辅信道：在交付前提醒清理）
 *
 * 拦截类（非提醒类）检查在 deliver-task.ts 的 gate 体系中执行——
 * 工具输出是必读信道，到达率高于 advisory 通道。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { detectProbes, type ProbeHit } from '../probe-detector.js'
import { extractWriteContents } from '../../tools/write-tool-helpers.js'

export interface ProbeTrackingHookDeps {
  /** Only `submit` is used — narrowed for testability. */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Session-scoped: file → probe hits found in write operations this session. */
interface ProbeTracker {
  /** Map<filePath, ProbeHit[]> — cumulative across turns. */
  probesByFile: Map<string, ProbeHit[]>
}

/**
 * Create the probe-tracking hook.
 *
 * The tracker is closure-scoped (not turn-scoped), surviving across turns
 * until the session ends. This is deliberate: a probe added in turn 3 and
 * forgotten until deliver_task in turn 10 must still be caught.
 *
 * Access the tracker via `getProbeTracker()` for deliver-task gate integration.
 */
export function createProbeTrackingHook(
  deps: ProbeTrackingHookDeps,
): PostToolRuntimeHook & { getProbeTracker: () => ProbeTracker; resetProbeTracker: () => void } {
  const tracker: ProbeTracker = { probesByFile: new Map() }

  const hook: PostToolRuntimeHook & { getProbeTracker: () => ProbeTracker; resetProbeTracker: () => void } = {
    phase: 'postTool',
    name: 'probe-tracking',
    getProbeTracker() { return tracker },
    resetProbeTracker() { tracker.probesByFile.clear() },
      run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
        const writes = extractWriteContents(tool.name, tool.input as Record<string, unknown> | undefined)
        if (writes.length === 0) return

        const allHits: ProbeHit[] = []
        for (const w of writes) {
          allHits.push(...detectProbes(w.content, w.filePath))
        }
        if (allHits.length === 0) return

        for (const hit of allHits) {
          const existing = tracker.probesByFile.get(hit.filePath) ?? []
          const isDup = existing.some(
            h => h.pattern === hit.pattern && h.line === hit.line,
          )
          if (!isDup) existing.push(hit)
          tracker.probesByFile.set(hit.filePath, existing)
        }

        deps.advisoryBus.submit({
          key: 'probe-tracking',
          priority: 0.52,
          category: 'discipline',
          content: `探针检测：${[...new Set(allHits.map(h => h.filePath))].join(', ')} 新增了调试探针（${[...new Set(allHits.map(h => h.pattern))].join(', ')}）。修复完成后、交付前记得清理这些探针——残留探针 = 任务未完成。`,
          ttl: 1,
        })
    },
  }

  return hook
}
