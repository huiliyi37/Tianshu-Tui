import type { DomainDriftResult } from '../agent/domain-drift-detector.js'

/** User-visible only; callers must keep this out of the model message history.
 *  漂移提示的引导（四条路径，均不碎当前会话的前缀缓存）：
 *  ① /capsule —— 正文经消息流注入（同 recall_capsule 的 cache-safe 纪律）；
 *  ② 多会话并行——新会话进推荐域做审查/规划，当前会话执行其结果（多会话
 *    多星域并行是本架构的原生形态，各会话前缀互不影响）；
 *  ③ /handoff 交接后新会话；④ 忽略。 */
export function formatDomainDriftNudge(drift: DomainDriftResult): string {
  return (
    `⚡ 检测到任务重心可能已从「${drift.currentName}」转为「${drift.recommendedName}」方向。` +
    '当前会话保持不变（会话内切换星域会重建前缀缓存）。四选一：' +
    `① /capsule ${drift.recommendedName} —— 把${drift.recommendedName}的完整认知方法注入本轮对话（消息级追加，零缓存代价，最多同时佩戴 2 枚）；` +
    `② 新开一个会话进入${drift.recommendedName}（/domain ${drift.recommendedId}）专做审查与规划，当前会话继续执行——多会话多星域并行，各会话前缀缓存互不影响，审查/规划结果交回当前会话采纳执行；` +
    '③ 先 /handoff 写交接摘要，再新开会话选择 Auto；' +
    '④ 忽略——任务方向未变时不建议动。'
  )
}
