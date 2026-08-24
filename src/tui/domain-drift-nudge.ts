import type { DomainDriftResult } from '../agent/domain-drift-detector.js'

/** User-visible only; callers must keep this out of the model message history. */
export function formatDomainDriftNudge(drift: DomainDriftResult): string {
  return (
    `⚡ 检测到任务重心可能已从「${drift.currentName}」转为「${drift.recommendedName}」方向。` +
    '当前会话保持不变（会话内切换星域会重建前缀缓存）。' +
    `建议先 /handoff 写交接摘要，再新开会话选择 Auto 或 ${drift.recommendedName}。`
  )
}
