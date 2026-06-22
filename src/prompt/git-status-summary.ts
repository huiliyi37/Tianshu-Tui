import { classifyPath } from '../context/attention-filter.js'

const SUMMARY_THRESHOLD = 1200

export interface GitStatusSummary {
  branch: string
  modified: string[]
  untracked: string[]
  staged: string[]
  deleted: string[]
  foldedRuntimeFragments: number
  foldedForeignFootprints: number
  omittedBuildOutputs: number
}

function emptySummary(branch = 'unknown'): GitStatusSummary {
  return {
    branch,
    modified: [],
    untracked: [],
    staged: [],
    deleted: [],
    foldedRuntimeFragments: 0,
    foldedForeignFootprints: 0,
    omittedBuildOutputs: 0,
  }
}

function pushPath(summary: GitStatusSummary, bucket: 'modified' | 'untracked' | 'staged' | 'deleted', filePath: string): void {
  const verdict = classifyPath(filePath)
  if (verdict.tier === 'L0_build') {
    summary.omittedBuildOutputs++
    return
  }
  if (verdict.tier === 'L1_fragment') {
    summary.foldedRuntimeFragments++
    return
  }
  if (verdict.tier === 'L2_foreign') {
    summary.foldedForeignFootprints++
    return
  }
  summary[bucket].push(filePath)
}

function parseBranch(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith('On branch ')) return line.replace('On branch ', '').trim() || 'unknown'
    if (line.startsWith('Current branch:')) return line.replace('Current branch:', '').trim() || 'unknown'
  }
  return 'unknown'
}

function renameTarget(filePath: string): string {
  const marker = ' -> '
  const idx = filePath.lastIndexOf(marker)
  const raw = idx >= 0 ? filePath.slice(idx + marker.length).trim() : filePath.trim()
  // git wraps non-ASCII filenames in double quotes with octal escapes (e.g.
  // ?? ".rivet/plans/某计划.md"). Strip the wrapping quotes so classifyPath
  // sees the real path prefix (.rivet → matches RIVET_RUNTIME_DIRS), not the
  // quoted form (".rivet → no match → falls through to L3_content).
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1)
  return raw
}

function isShortStatus(lines: string[]): boolean {
  return lines.some(line => /^(?:[ MADRCU?!]{2}|\?\?)\s+/.test(line))
}

function parseShortGitStatus(lines: string[]): GitStatusSummary {
  const summary = emptySummary(parseBranch(lines))

  for (const line of lines) {
    if (line.startsWith('Current branch:') || line === 'Status:' || line.trim() === '' || line.startsWith('Recent commits:')) continue

    const match = line.match(/^(.)(.)\s+(.+)$/)
    if (!match) continue

    const x = match[1]!
    const y = match[2]!
    const filePath = renameTarget(match[3]!)

    if (x === '?' && y === '?') {
      pushPath(summary, 'untracked', filePath)
      continue
    }

    if (x === 'D' || y === 'D') {
      pushPath(summary, 'deleted', filePath)
      continue
    }

    if (x !== ' ' && x !== '?' && x !== '!') {
      pushPath(summary, 'staged', filePath)
      continue
    }

    if (y !== ' ' && y !== '?' && y !== '!') {
      pushPath(summary, 'modified', filePath)
    }
  }

  return summary
}

function parseLongGitStatus(lines: string[]): GitStatusSummary {
  const summary = emptySummary(parseBranch(lines))
  let section: 'staged' | 'modified' | 'untracked' | 'other' = 'other'

  for (const line of lines) {
    if (line.includes('Changes to be committed:')) { section = 'staged'; continue }
    if (line.includes('Changes not staged for commit:')) { section = 'modified'; continue }
    if (line.includes('Untracked files:')) { section = 'untracked'; continue }
    if (line.startsWith('##') || line.startsWith('On branch') || line.startsWith('Current branch:') || line.trim() === '') continue

    const fileMatch = line.match(/^\s+(?:modified|new file|renamed|deleted):\s+(.+)$/)
    if (fileMatch) {
      const filePath = renameTarget(fileMatch[1]!)
      if (line.includes('deleted:')) {
        pushPath(summary, 'deleted', filePath)
      } else if (section === 'staged') {
        pushPath(summary, 'staged', filePath)
      } else if (section === 'modified') {
        pushPath(summary, 'modified', filePath)
      }
      continue
    }

    if (section === 'untracked') {
      const untrackedLine = line.match(/^\s+(.+)$/)
      if (!untrackedLine) continue
      const filePath = untrackedLine[1]!.trim()
      if (filePath && !filePath.endsWith(':') && !filePath.startsWith('(use ')) {
        pushPath(summary, 'untracked', filePath)
      }
    }
  }

  return summary
}

export function parseGitStatus(status: string): GitStatusSummary {
  const lines = status.split('\n')
  return isShortStatus(lines) ? parseShortGitStatus(lines) : parseLongGitStatus(lines)
}

function renderSummary(summary: GitStatusSummary): string {
  // 完整性标注：摘要必须自我声明"这就是全貌"，否则模型会把摘要当成不完整的
  // 截断输出，转头用 bash 重跑 git status 形成 doom-loop（会话 43443098 取证）。
  const total = summary.staged.length + summary.modified.length + summary.untracked.length + summary.deleted.length
  const foldedTotal = summary.foldedRuntimeFragments + summary.foldedForeignFootprints + summary.omittedBuildOutputs
  const completeness = foldedTotal > 0
    ? `共 ${total} 个任务相关文件（完整列表），另有 ${foldedTotal} 个无关项已折叠`
    : `共 ${total} 个文件（完整列表）`
  const parts: string[] = [`[${summary.branch}] ${completeness} — 此状态即当前工作区全貌，无需再跑 git status`]

  if (summary.staged.length > 0) {
    parts.push(`${summary.staged.length} staged: ${summary.staged.join(', ')}`)
  }
  if (summary.modified.length > 0) {
    parts.push(`${summary.modified.length} modified: ${summary.modified.join(', ')}`)
  }
  if (summary.untracked.length > 0) {
    parts.push(`${summary.untracked.length} untracked: ${summary.untracked.join(', ')}`)
  }
  if (summary.deleted.length > 0) {
    parts.push(`${summary.deleted.length} deleted: ${summary.deleted.join(', ')}`)
  }
  if (summary.foldedRuntimeFragments > 0) {
    parts.push(`${summary.foldedRuntimeFragments} runtime fragments folded`)
  }
  if (summary.foldedForeignFootprints > 0) {
    parts.push(`${summary.foldedForeignFootprints} foreign tool footprint${summary.foldedForeignFootprints === 1 ? '' : 's'} folded`)
  }
  if (summary.omittedBuildOutputs > 0) {
    parts.push(`${summary.omittedBuildOutputs} build outputs omitted`)
  }
  if (foldedTotal > 0) {
    parts.push('被折叠项均与编码任务无关（运行时碎片/外部工具足迹/构建产物）；如确需查看，用 git 工具，不要用 bash 重跑 git status。')
  }

  return parts.join('\n')
}

export function summarizeGitStatus(status: string): string {
  if (!status) return status

  const lines = status.split('\n')
  const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
  const statusPart = commitIdx >= 0 ? lines.slice(0, commitIdx).join('\n').trim() : status
  const commitsPart = commitIdx >= 0 ? lines.slice(commitIdx).join('\n').trim() : ''

  const shouldSummarize = status.length > SUMMARY_THRESHOLD || isShortStatus(statusPart.split('\n'))
  if (!shouldSummarize) return status

  const summary = renderSummary(parseGitStatus(statusPart))
  return commitsPart ? `${summary}\n${commitsPart}` : summary
}
