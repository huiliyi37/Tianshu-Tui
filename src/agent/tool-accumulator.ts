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
}

export interface CollapseResult {
  collapsedIds: string[]
  summary: string
}

const CONSECUTIVE_THRESHOLD = 4
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
    const consecutive = this.getConsecutiveTail(toolName)
    if (consecutive.length < CONSECUTIVE_THRESHOLD) return null

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
    const files = entries.map(e => {
      const lines = e.content.split('\n')
      return `${lines.length} lines`
    })
    return `[storm-collapsed: ${count} read_file calls, ${totalChars} chars collapsed, sizes: ${files.join(', ')}]`
  }

  private buildBashSummary(entries: AccumulatorEntry[], count: number, totalChars: number): string {
    const lastLines = entries.map(e => {
      const lines = e.content.trim().split('\n')
      return lines[lines.length - 1] ?? ''
    })
    const preview = lastLines
      .slice(0, MAX_AGGREGATE_LINES)
      .map(l => `  ${l}`)
      .join('\n')
    return `[storm-collapsed: ${count} bash calls, ${totalChars} chars collapsed]\nLast lines:\n${preview}`
  }

  private buildGenericSummary(toolName: string, entries: AccumulatorEntry[], count: number, totalChars: number): string {
    return `[storm-collapsed: ${count} ${toolName} calls, ${totalChars} chars collapsed]`
  }
}
