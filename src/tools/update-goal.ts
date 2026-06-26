/**
 * update_goal tool — model-driven goal lifecycle control.
 *
 * Lets the model actively declare paused/blocked/complete through a tool call,
 * instead of only relying on regex-detected "GOAL ACHIEVED" text output.
 *
 * Uses the same closure pattern as createDeliverTaskTool: the goal tracker ref
 * is captured at registration time, avoiding any ToolPipelineDeps plumbing.
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { GoalTracker } from '../agent/goal-tracker.js'

type GoalTrackerRef = { current: GoalTracker | null }

export function createUpdateGoalTool(getTracker: () => GoalTracker | null): Tool {
  return {
    definition: {
      name: 'update_goal',
      description: `Update the current goal lifecycle status. Only available when a goal is active.

### When to call
- Use status="complete" when all work toward the goal is genuinely done.
- Use status="blocked" when an external condition prevents progress (missing dependency, env issue).
- Use status="paused" when you need user input before continuing.

### Parameters
- status: paused | blocked | complete
- reason (optional): brief explanation of why this status is being set.`,
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'The lifecycle status to set: paused, blocked, or complete.',
          },
          reason: {
            type: 'string',
            description: 'Brief explanation of why this status is being set.',
          },
        },
        required: ['status'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const tracker = getTracker()
      if (!tracker) {
        return { content: 'No active goal to update.', isError: true }
      }
      if (tracker.getStatus() !== 'active') {
        return {
          content: `Goal is currently ${tracker.getStatus()}, cannot update via update_goal.`,
          isError: true,
        }
      }

      const status = params.input.status
      const reason = typeof params.input.reason === 'string' ? params.input.reason : undefined

      if (status !== 'paused' && status !== 'blocked' && status !== 'complete') {
        return { content: `Invalid status "${status}". Allowed: paused, blocked, complete.`, isError: true }
      }

      try {
        if (status === 'complete') {
          tracker.markComplete('model')
        } else if (status === 'blocked') {
          tracker.markBlocked(reason ?? 'Blocked by model', 'model')
        } else {
          tracker.pause(reason ?? 'Paused by model', 'model')
        }
        return { content: `Goal status updated to ${status}.` }
      } catch (e) {
        return { content: `Transition failed: ${(e as Error).message}`, isError: true }
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
