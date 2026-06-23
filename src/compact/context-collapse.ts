/**
 * Context Collapse: replaces old tool results with semantic summaries.
 *
 * Inspired by Claude Code's Context Collapse strategy — instead of simple
 * truncation (keep first N chars), extract the semantic meaning of a tool
 * result and replace it with a compact summary.
 *
 * Example: a 2000-char grep result becomes "grep 'foo' in src/ → 14 matches
 * across 8 files" (~50 chars). This is 40x compression with high signal retention.
 */

export interface CollapsedResult {
  toolName: string
  summary: string
  originalTokens: number
  collapsedTokens: number
}

const CHARS_PER_TOKEN = 4

/**
 * Attempt to collapse a tool result into a semantic summary.
 * Returns null if the result is too small to be worth collapsing (< 200 chars)
 * or if the tool type is not recognized.
 *
 * @param toolName  - The tool that produced this result
 * @param content   - The full text content of the tool result
 * @param turnAge   - How many turns ago this result was produced (0 = current turn)
 * @param contextWindow - The total context window size in tokens
 */
export function collapseToolResult(
  toolName: string,
  content: string,
  turnAge: number,
  _contextWindow: number,
): CollapsedResult | null {
  if (content.length < 200) return null
  if (turnAge < 2) return null

  const originalTokens = Math.ceil(content.length / CHARS_PER_TOKEN)

  let result: CollapsedResult
  if (toolName === 'grep' || toolName === 'search') {
    result = collapseGrepResult(toolName, content, originalTokens)
  } else if (toolName === 'read_file') {
    result = collapseReadFileResult(content, originalTokens)
  } else if (toolName === 'bash') {
    result = collapseBashResult(content, originalTokens)
  } else if (toolName === 'write_file' || toolName === 'edit_file') {
    result = collapseWriteResult(toolName, content, originalTokens)
  } else {
    result = collapseGenericResult(toolName, content, originalTokens)
  }

  return preserveArtifactRef(content, result)
}

/**
 * T7 layering: request-layer collapse must not become a recall blind spot.
 * Large tool results carry a trailing/leading `[artifact:id]` marker (added by
 * the storage-layer artifact intercept). When T7 folds such a result into a
 * `[collapsed ...]` summary, preserve the artifact id so the model can still
 * read_section it — the storage original is untouched, only the request copy is
 * folded, so the reference stays valid. Results without a marker are left as-is
 * (no disk write on the request hot path); their storage original is intact and
 * naturally restored when fillRatio recovers.
 */
function preserveArtifactRef(content: string, result: CollapsedResult): CollapsedResult {
  const artifactId = content.match(/\[artifact:([^\]]+)\]/)?.[1]
  if (!artifactId || result.summary.includes(artifactId)) return result
  // Insert the recall hint before the closing bracket of the summary.
  const summary = result.summary.endsWith(']')
    ? `${result.summary.slice(0, -1)} | read_section artifact:${artifactId}]`
    : `${result.summary} [read_section artifact:${artifactId}]`
  return { ...result, summary, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseGrepResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  const lines = content.split('\n').filter(l => l.trim())
  const fileSet = new Set<string>()
  let matchCount = 0

  for (const line of lines) {
    const m = line.match(/^([^\s:]+):/)
    if (m) {
      fileSet.add(m[1]!)
      matchCount++
    }
  }

  const files = [...fileSet]
  const topFiles = files.slice(0, 8)
  const moreFiles = files.length > 8 ? ` (+${files.length - 8} more)` : ''

  const summary = `[collapsed ${toolName}: ${matchCount} matches in ${files.length} files: ${topFiles.join(', ')}${moreFiles}]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseReadFileResult(
  content: string,
  originalTokens: number,
  maxScanLines = 100,
): CollapsedResult {
  const lines = content.split('\n')
  const lineCount = lines.length

  const exports: string[] = []
  const functions: string[] = []
  const classes: string[] = []

  for (const line of lines.slice(0, maxScanLines)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('export ')) exports.push(trimmed.slice(0, 80))
    if (/^(export\s+)?(async\s+)?function\s+\w/.test(trimmed)) {
      const name = trimmed.match(/function\s+(\w+)/)?.[1]
      if (name) functions.push(name)
    }
    if (/^(export\s+)?class\s+\w/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1]
      if (name) classes.push(name)
    }
  }

  const parts: string[] = [`${lineCount} lines`]
  if (classes.length > 0) parts.push(`classes: ${classes.slice(0, 5).join(', ')}`)
  if (functions.length > 0) parts.push(`functions: ${functions.slice(0, 8).join(', ')}`)
  if (exports.length > 0 && classes.length === 0 && functions.length === 0) {
    parts.push(`${exports.length} exports`)
  }

  const summary = `[collapsed read_file: ${parts.join(', ')}]`
  return { toolName: 'read_file', summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseBashResult(content: string, originalTokens: number): CollapsedResult {
  const lines = content.split('\n').filter(l => l.trim())
  const lineCount = lines.length

  const lastLines = lines.slice(-3)
  const exitCodeMatch = content.match(/exit code[:\s]+(\d+)/i)
  const exitCode = exitCodeMatch?.[1] ?? null

  // Extract fail/error lines — highest signal in test output
  const failPattern = /fail|error|FAIL|ERROR|✗|✘|❌/i
  const failLines = lines
    .filter(l => failPattern.test(l) && !/^\s*[✓✔●◌⊙]/.test(l))
    .slice(0, 5)

  const parts: string[] = [`${lineCount} lines output`]
  if (exitCode !== null) parts.push(`exit ${exitCode}`)
  if (failLines.length > 0) parts.push(`fails: ${failLines.map(l => l.slice(0, 80)).join(' | ')}`)
  parts.push(`tail: ${lastLines.map(l => l.slice(0, 60)).join(' | ')}`)

  const summary = `[collapsed bash: ${parts.join(', ')}]`
  return { toolName: 'bash', summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

function collapseWriteResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  const summary = `[collapsed ${toolName}: ${content.length} chars written]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseGenericResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  const lines = content.split('\n')
  const preview = lines.slice(0, 3).map(l => l.slice(0, 80)).join(' | ')
  const summary = `[collapsed ${toolName}: ${lines.length} lines, ${content.length} chars. Preview: ${preview}]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}
