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
    case 'circuit_open': return '熔断开启 · 已退避'
    case 'claim_conflict': return '文件归属冲突 · 已降级'
    case 'schema_mismatch': return '结果形状不符 · 已降级'
    case 'policy_short_circuit': return '策略短路'
    case 'unknown': return '失败原因未归类'
    default: break
  }
  if (evidenceStatus === 'failed') return '验收证据验证失败'
  return null
}

export interface WorkerResultDigestInput {
  /** 输入域 = WorkerResult.status（passed/failed/blocked/escalated）——三个生产
   *  调用方（galaxy ×2、delegate-task、worker-detail）全传协议层结果。
   *  收口后的 UI 词汇 'completed' 不经此接缝。 */
  status: 'passed' | 'failed' | 'blocked' | 'escalated'
  summary: string
  findingsCount: number
  changedFilesCount: number
  failureReason?: string
  evidenceStatus?: string
  /** Worker 自报的研究覆盖规模（sourcesReviewed 透传），存在且 >0 时展示。 */
  sourcesReviewedCount?: number
  /** 打捞恢复的 findings 条数（findings 中 salvaged===true 的计数）。>0 时
   *  追加「未经核实」警告——打捞内容可能含模型幻觉引用，必须与正常 findings
   *  区分对待（见 work-order.ts salvageWorkerResult 的 provenance 标记）。 */
  salvagedFindingsCount?: number
}

/** 结果一句话摘要（detail 头部 + delegate_task uiContent 复用）。
 *  形态：`glyph summary · N 条发现 · M 个文件[· ⚠ 诚实标签]`。summary 压平换行。 */
export function formatWorkerResultDigest(r: WorkerResultDigestInput): string {
  const ok = r.status === 'passed'
  const glyph = ok ? '✓' : r.status === 'blocked' ? '⊗' : r.status === 'escalated' ? '↑' : '✗'
  const summary = r.summary.replace(/\s+/g, ' ').trim()
  const parts: string[] = [`${glyph} ${summary}`]
  if (r.findingsCount > 0) parts.push(`${r.findingsCount} 条发现`)
  if (r.changedFilesCount > 0) parts.push(`${r.changedFilesCount} 个文件`)
  if (r.sourcesReviewedCount !== undefined && r.sourcesReviewedCount > 0) parts.push(`${r.sourcesReviewedCount} 个来源`)
  const honesty = digestHonesty(r.failureReason, r.evidenceStatus)
  if (honesty) parts.push(`⚠ ${honesty}`)
  if (r.salvagedFindingsCount !== undefined && r.salvagedFindingsCount > 0) {
    parts.push(`⚠ ${r.salvagedFindingsCount} 条打捞发现未经核实（引用可能为幻觉）`)
  }
  return parts.join(' · ')
}
