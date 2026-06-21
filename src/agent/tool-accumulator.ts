/**
 * Tracks consecutive tool calls of the same type within a turn.
 * When a tool storm is detected (4+ consecutive same-type calls),
 * collapses stale results into an aggregate summary, preserving
 * only the most recent result in full.
 *
 * Addresses session b3d6f29a pattern: 24 consecutive grep calls with
 * different search terms, each producing ~600 tokens, burying user intent.
 */

export interface AccumulatorEntry {
  toolName: string
  toolUseId: string
  content: string
  turn: number
  /** Raw output bytes before truncation (for collapse summaries). */
  rawBytes?: number
  /** Raw output lines before truncation (for collapse summaries). */
  rawLines?: number
  /** Exit code (bash). */
  exitCode?: number
  /** Executed command (bash) — displayed in per-command collapse summaries. */
  command?: string
}

export interface CollapseResult {
  collapsedIds: string[]
  summary: string
}

const CONSECUTIVE_THRESHOLD = 4

/**
 * Reader tools (read_file, glob, grep) provide the model with source code context.
 * Collapsing their output — the very content the model needs to understand and edit
 * the codebase — is counterproductive. The summaries ("929 lines, 158 lines" etc.)
 * carry no actionable signal.
 *
 * These tools are already bounded: read_file has per-call line limits, grep caps
 * at 100 results, glob at 500 files. The request-time context collapse (2+ turns
 * old) still applies, so stale reads are eventually compacted.
 *
 * Consecutive threshold of 12 means the model can make up to 11 sequential
 * read_file/glob/grep calls without triggering storm collapse — enough for
 * any reasonable exploration pattern without flooding context.
 */
const READER_CONSECUTIVE_THRESHOLD = 12

const READER_TOOLS = new Set(['read_file', 'glob', 'grep', 'read_section', 'run_tests'])
const MAX_AGGREGATE_LINES = 30

export class ToolAccumulator {
  private entries: AccumulatorEntry[] = []

  record(entry: AccumulatorEntry): void {
    this.entries.push(entry)
  }

  reset(): void {
    this.entries = []
  }

  /**
   * Returns the number of consecutive calls for the given tool type
   * at the tail of the accumulator.
   */
  consecutiveCount(toolName: string): number {
    let count = 0
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.toolName === toolName) count++
      else break
    }
    return count
  }

  /**
   * When consecutive same-type calls reach the threshold, generates a
   * collapse summary for all but the most recent result.
   * Returns null if no collapse is needed.
   */
  tryCollapse(toolName: string): CollapseResult | null {
    const threshold = READER_TOOLS.has(toolName) ? READER_CONSECUTIVE_THRESHOLD : CONSECUTIVE_THRESHOLD
    const consecutive = this.getConsecutiveTail(toolName)
    if (consecutive.length < threshold) return null

    const stale = consecutive.slice(0, -1)
    const collapsedIds = stale.map(e => e.toolUseId)

    const summary = this.buildSummary(toolName, stale)
    return { collapsedIds, summary }
  }

  private getConsecutiveTail(toolName: string): AccumulatorEntry[] {
    const result: AccumulatorEntry[] = []
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.toolName === toolName) result.unshift(this.entries[i]!)
      else break
    }
    return result
  }

  private buildSummary(toolName: string, entries: AccumulatorEntry[]): string {
    const count = entries.length
    const totalChars = entries.reduce((sum, e) => sum + e.content.length, 0)

    if (toolName === 'grep' || toolName === 'search') {
      return this.buildGrepSummary(entries, count, totalChars)
    }
    if (toolName === 'read_file') {
      return this.buildReadFileSummary(entries, count, totalChars)
    }
    if (toolName === 'bash') {
      return this.buildBashSummary(entries, count, totalChars)
    }
    return this.buildGenericSummary(toolName, entries, count, totalChars)
  }

  private buildGrepSummary(entries: AccumulatorEntry[], count: number, totalChars: number): string {
    const matchCounts: number[] = []
    const filesSeen = new Set<string>()

    for (const e of entries) {
      const lines = e.content.split('\n')
      let matches = 0
      for (const line of lines) {
        const fileMatch = line.match(/^([^\s:]+):/)
        if (fileMatch) {
          filesSeen.add(fileMatch[1]!)
          matches++
        }
      }
      matchCounts.push(matches || lines.length)
    }

    const totalMatches = matchCounts.reduce((a, b) => a + b, 0)
    const topFiles = [...filesSeen].slice(0, 10)

    const lines = [
      `[storm-collapsed: ${count} grep calls → ${totalMatches} total matches across ${filesSeen.size} files, ${totalChars} chars collapsed]`,
      `Top files: ${topFiles.join(', ')}${filesSeen.size > 10 ? ` (+${filesSeen.size - 10} more)` : ''}`,
    ]
    return lines.join('\n')
  }

  private buildReadFileSummary(entries: AccumulatorEntry[], count: number, totalChars: number): string {
    // Extract file paths from content headers like "── src/tools/hash-edit.ts ──"
    const paths: string[] = []
    for (const e of entries) {
      const headerMatch = e.content.match(/──\s*(.+?)\s*──/)
      if (headerMatch) {
        paths.push(headerMatch[1]!)
      }
    }
    const pathInfo = paths.length > 0
      ? `files: ${paths.join(', ')}`
      : `sizes: ${entries.map(e => e.content.split('\n').length + ' lines').join(', ')}`
    return `[storm-collapsed: ${count} read_file calls, ${totalChars} chars collapsed, ${pathInfo}]`
  }

  private buildBashSummary(entries: AccumulatorEntry[], count: number, totalChars: number): string {
    // Parse per-command metadata from the output header:
    //   [ls -la .rivet/sessions/] exit=0 time=0.1s lines=248
    const headerRe = /^\[(.+?)\]\s+exit=(\d+)\s+time=[\d.]+\S\s+lines=(\d+)/
    const cmdLines: string[] = []
    for (const e of entries) {
      const m = e.content.match(headerRe)
      if (m) {
        const cmd = m[1]!.length > 72 ? m[1]!.slice(0, 69) + '…' : m[1]!
        const exit = m[2]!
        const lines = m[3]!
        cmdLines.push(`  ${cmd}  exit=${exit}  ${lines} lines  (collapsed)`)
      } else {
        // Fallback: show content size
        const preview = e.content.slice(0, 80).replace(/\n/g, '↵')
        cmdLines.push(`  [unrecognized header] ${e.content.length} chars  (collapsed)`)
      }
    }

    // Last output preview from most recent entry
    const last = entries[entries.length - 1]!
    const lastLines = last.content.trim().split('\n')
    const lastPreview = lastLines.slice(-8)
      .map(l => `  ${l}`)
      .join('\n')
    const lastCmd = last.command ?? (last.content.match(headerRe)?.[1] ?? 'unknown')

    const parts = [
      `[storm-collapsed: ${count} bash calls consolidated — raw output saved, use rawPath or read_section to recover]`,
      ...cmdLines,
      `Last output from most recent call (${lastCmd}):`,
      lastPreview,
    ]
    return parts.join('\n')
  }

  private buildGenericSummary(toolName: string, entries: AccumulatorEntry[], count: number, totalChars: number): string {
    return `[storm-collapsed: ${count} ${toolName} calls, ${totalChars} chars collapsed]`
  }
}
