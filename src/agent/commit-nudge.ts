/**
 * commit-nudge — 写后累积推力 (B1-8c)
 *
 * 纯函数模块。根据未提交 owned files 的数量和区域分布，
 * 生成一段推力文本，由 tool-pipeline 在每次 file_write 后
 * 追加到工具结果中。
 *
 * 阈值设计：
 * - >4 files 或 >2 areas → 注入推力
 * - 这个阈值比 commit-cohesion 的门禁阈值（>5 files / >2 areas）低一级
 *   推力先出现，门禁后出现，形成"先提醒后阻止"的渐进摩擦。
 *
 * @module commit-nudge
 */

export interface NudgeInput {
  /** 当前所有 owned files（来自 TaskLedger.getOwnedFiles()） */
  ownedFiles: string[]
}

/** 提取文件的顶层目录（前两个路径段） */
function extractTopDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return '.'
  return parts.slice(0, 2).join('/')
}

const NUDGE_FILE_THRESHOLD = 4
const NUDGE_AREA_THRESHOLD = 2

/**
 * Build a commit nudge string to append to tool results after file writes.
 * Returns empty string when no nudge is needed.
 *
 * Output includes exact commands for weak models to copy-paste.
 */
export function buildCommitNudge(input: NudgeInput): string {
  const { ownedFiles } = input
  if (ownedFiles.length <= NUDGE_FILE_THRESHOLD) return ''

  const topDirs = new Set(ownedFiles.map(extractTopDir))

  const lines: string[] = [
    '',
    '💡 Uncommitted files accumulating: ' + ownedFiles.length + ' owned files across ' + topDirs.size + ' areas.',
    '   Next step: deliver_task commit=true message="your message" files=[your completed files]',
  ]

  return lines.join('\n')
}
