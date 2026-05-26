import { type LogEntry } from './log-state.js'
import { getGroupSummary } from './tool-family.js'

const GROUP_THRESHOLD = 5

export function groupLogs(items: readonly LogEntry[]): LogEntry[] {
  const result: LogEntry[] = []
  let toolRun: LogEntry[] = []
  let currentTurn: number | undefined

  const flushToolRun = () => {
    if (toolRun.length >= GROUP_THRESHOLD) {
      // Use first child's id prefixed with 'g' for stable identity
      const stableId = `g-${toolRun[0]!.id}`
      result.push({
        type: 'tool_group',
        id: stableId,
        content: getGroupSummary(toolRun),
        children: [...toolRun],
        turnNumber: toolRun[0]!.turnNumber,
      })
    } else {
      result.push(...toolRun)
    }
    toolRun = []
  }

  for (const item of items) {
    if (item.type === 'tool') {
      // Break grouping when turnNumber changes
      if (item.turnNumber !== undefined && item.turnNumber !== currentTurn && toolRun.length > 0) {
        flushToolRun()
      }
      currentTurn = item.turnNumber
      toolRun.push(item)
    } else {
      flushToolRun()
      result.push(item)
    }
  }
  flushToolRun()

  return result
}
