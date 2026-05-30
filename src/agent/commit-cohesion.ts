/**
 * commit-cohesion — 提交内聚性检测 (B1-8b)
 *
 * 纯函数模块。检查即将提交的文件列表是否跨越过多逻辑区域。
 * 超阈值时返回 needsWarning=true，由 deliver_task 作为 RED 门禁使用。
 *
 * @module commit-cohesion
 */

export interface CohesionReport {
  /** 按顶层目录分组的区域列表（去重排序） */
  topDirs: string[]
  /** 唯一顶层目录数 */
  topDirCount: number
  /** 文件总数 */
  fileCount: number
  /** 是否应显示内聚性门禁 */
  needsWarning: boolean
  /** 人类可读的警告行 */
  warningLines: string[]
  /** 按区域分好的拆分方案，可直接执行 */
  splitSuggestion: string[]
}

export interface CohesionThresholds {
  /** 超过此文件数触发门禁（默认 5） */
  maxFiles?: number
  /** 超过此顶层目录数触发门禁（默认 2） */
  maxTopDirs?: number
}

/** 提取文件的顶层目录（前两个路径段） */
function extractTopDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return '.'
  return parts.slice(0, 2).join('/')
}

export function checkCommitCohesion(
  files: string[],
  thresholds?: CohesionThresholds,
): CohesionReport {
  const maxFiles = thresholds?.maxFiles ?? 5
  const maxTopDirs = thresholds?.maxTopDirs ?? 2

  const topDirSet = new Set<string>()
  for (const f of files) {
    topDirSet.add(extractTopDir(f))
  }
  const topDirs = [...topDirSet].sort()
  const topDirCount = topDirs.length
  const fileCount = files.length

  const overFileLimit = fileCount > maxFiles
  const overDirLimit = topDirCount > maxTopDirs
  const needsWarning = overFileLimit || overDirLimit

  const warningLines: string[] = []
  const splitSuggestion: string[] = []
  if (needsWarning) {
    const areaSummary = topDirs.join(', ')
    if (overDirLimit) {
      warningLines.push(
        `❌ Commit cohesion gate: ${fileCount} owned files across ${topDirCount} areas (${areaSummary}).`,
      )
    } else {
      warningLines.push(
        `❌ Commit cohesion gate: ${fileCount} owned files. Large commit — verify all changes are one logical unit.`,
      )
    }
    warningLines.push(
      'If this truly is one logical unit, re-run with force=true to override.',
    )

    // Generate concrete split suggestion by area — weak models need exact commands
    const filesByArea = new Map<string, string[]>()
    for (const f of files) {
      const dir = extractTopDir(f)
      const existing = filesByArea.get(dir)
      if (existing) existing.push(f)
      else filesByArea.set(dir, [f])
    }
    const sortedAreas = [...filesByArea.entries()].sort(([a], [b]) => a.localeCompare(b))
    for (const [area, areaFiles] of sortedAreas) {
      const fileList = areaFiles.map(f => `"${f}"`).join(', ')
      splitSuggestion.push(
        `deliver_task commit=true message="描述" files=[${fileList}]`,
      )
    }
    warningLines.push(
      'Suggested split by area:',
    )
    for (const cmd of splitSuggestion) {
      warningLines.push(`  ${cmd}`)
    }
  }

  return { topDirs, topDirCount, fileCount, needsWarning, warningLines, splitSuggestion }
}
