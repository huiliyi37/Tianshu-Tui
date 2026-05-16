import { createLogEntry, type LogEntry } from './log-state.js'
import { getGroupSummary } from './tool-family.js'

const GROUP_THRESHOLD = 3

export function groupLogs(items: readonly LogEntry[]): LogEntry[] {
  const result: LogEntry[] = []
  let toolRun: LogEntry[] = []
  let currentTurn: number | undefined

  const flushToolRun = () => {
    if (toolRun.length >= GROUP_THRESHOLD) {
      result.push(createLogEntry({
        type: 'tool_group',
        content: getGroupSummary(toolRun),
        children: [...toolRun],
        turnNumber: toolRun[0]!.turnNumber,
      }))
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
