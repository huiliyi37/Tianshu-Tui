/**
 * worker 结果一句话摘要（digest）——中性层格式化器。
 *
 * 从 `tui/format/profile-labels.ts` 迁出：delegate_task（tools 层）的 uiContent
 * 与 worker-detail（tui 层）共用，tools → tui 的反向依赖就此断开。
 *
 * 数据形状对齐 `WorkerResult`（agent/work-order.ts），文案是面向人的中文摘要。
 */

/** 诚实标签：failureReason → 人类可读警告；evidenceStatus='failed' 兜底。
 *  判据顺序与原 worker-detail.honestyLabel 一致——先看失败根因，
 *  再看「验收证据不成立」（主控写闸门 / verification 块失败抓到的质量问题）。 */
function digestHonesty(failureReason?: string, evidenceStatus?: string): string | null {
  switch (failureReason) {
    case 'max_turns': return '预算耗尽 · 摘要可能不完整'
    case 'stalled': return '空跑 · 预算耗尽却几乎无工具调用（纯推理空转）'
    case 'json_parse': return '结果解析失败 · 已从碎片恢复'
    case 'worker_crash': return 'Worker 异常终止'
    case 'timeout': return 'Worker 超时'
    case 'caller_aborted': return '已被取消'
    case 'worker_blocked': return 'Worker 被阻断'
    default: break
  }
  if (evidenceStatus === 'failed') return '验收证据验证失败'
  return null
}

export interface WorkerResultDigestInput {
  status: 'passed' | 'completed' | 'failed' | 'blocked' | 'escalated'
  summary: string
  findingsCount: number
  changedFilesCount: number
  failureReason?: string
  evidenceStatus?: string
  /** Worker 自报的研究覆盖规模（sourcesReviewed 透传），存在且 >0 时展示。 */
  sourcesReviewedCount?: number
}

/** 结果一句话摘要（detail 头部 + delegate_task uiContent 复用）。
 *  形态：`glyph summary · N 条发现 · M 个文件[· ⚠ 诚实标签]`。summary 压平换行。 */
export function formatWorkerResultDigest(r: WorkerResultDigestInput): string {
  const ok = r.status === 'passed' || r.status === 'completed'
  const glyph = ok ? '✓' : r.status === 'blocked' ? '⊗' : r.status === 'escalated' ? '↑' : '✗'
  const summary = r.summary.replace(/\s+/g, ' ').trim()
  const parts: string[] = [`${glyph} ${summary}`]
  if (r.findingsCount > 0) parts.push(`${r.findingsCount} 条发现`)
  if (r.changedFilesCount > 0) parts.push(`${r.changedFilesCount} 个文件`)
  if (r.sourcesReviewedCount !== undefined && r.sourcesReviewedCount > 0) parts.push(`${r.sourcesReviewedCount} 个来源`)
  const honesty = digestHonesty(r.failureReason, r.evidenceStatus)
  if (honesty) parts.push(`⚠ ${honesty}`)
  return parts.join(' · ')
}
