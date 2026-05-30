export interface CommitAuditResult {
  ok: boolean
  tags: string[]
  message: string
}

const TASK_TAG_RE = /\b([SBCML]\d+[a-z]?)\b/g

/** Extract task tags (S14, M1, C2a etc.) from commit message. */
export function extractTaskTags(message: string): string[] {
  return [...message.matchAll(TASK_TAG_RE)].map(m => m[1]!)
}

/**
 * Validate commit message task tags against actual changed files.
 * Only audits when message contains tags (untagged commits pass through).
 * - Tag present but 0 files → warns (empty/mislabel, like 933887d S14).
 * - Tags > files → warns (multi-task scope creep signal, like 1adcf6c).
 */
export function auditCommitTagScope(message: string, changedFiles: string[]): CommitAuditResult {
  const tags = extractTaskTags(message)
  if (tags.length === 0) {
    return { ok: true, tags, message: '' }
  }
  if (changedFiles.length === 0) {
    return { ok: false, tags, message: `⚠️ Commit tagged ${tags.join(',')} but changed 0 files — possible mislabel or empty commit.` }
  }
  if (tags.length > 1 && changedFiles.length < tags.length) {
    return { ok: false, tags, message: `⚠️ Commit claims ${tags.length} task tags (${tags.join(',')}) but changed only ${changedFiles.length} file(s) — possible multiple unrelated tasks in one commit.` }
  }
  return { ok: true, tags, message: '' }
}
