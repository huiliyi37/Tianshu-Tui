const SUMMARY_THRESHOLD = 1200

export interface GitStatusSummary {
  branch: string
  modified: string[]
  untracked: string[]
  staged: string[]
  deleted: string[]
}

export function parseGitStatus(status: string): GitStatusSummary {
  const lines = status.split('\n')
  const branch = lines.find(l => l.startsWith('On branch'))?.replace('On branch ', '') ?? 'unknown'
  const modified: string[] = []
  const untracked: string[] = []
  const staged: string[] = []
  const deleted: string[] = []

  let section: 'staged' | 'modified' | 'untracked' | 'other' = 'other'

  for (const line of lines) {
    if (line.includes('Changes to be committed:')) { section = 'staged'; continue }
    if (line.includes('Changes not staged for commit:')) { section = 'modified'; continue }
    if (line.includes('Untracked files:')) { section = 'untracked'; continue }
    if (line.startsWith('##') || line.startsWith('On branch') || line.trim() === '') continue

    const fileMatch = line.match(/^\s+(?:modified|new file|renamed|deleted):\s+(.+)$/)
    if (fileMatch) {
      const path = fileMatch[1]!.trim()
      if (line.includes('deleted:')) {
        deleted.push(path)
      } else if (section === 'staged') {
        staged.push(path)
      } else if (section === 'modified') {
        modified.push(path)
      }
      continue
    }

    const untrackedMatch = line.match(/^\s+(.+\.\w+)$/)
    if (untrackedMatch && section === 'untracked') {
      untracked.push(untrackedMatch[1]!.trim())
    }
  }

  return { branch, modified, untracked, staged, deleted }
}

export function summarizeGitStatus(status: string): string {
  if (!status || status.length <= SUMMARY_THRESHOLD) return status

  const summary = parseGitStatus(status)
  const parts: string[] = [`[${summary.branch}]`]

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

  return parts.join('\n')
}
