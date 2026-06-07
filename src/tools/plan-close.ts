import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { relative } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePath } from './path-validate.js'
import { closePlanMarkdown, type PlanCloseOptions, type PlanCloseResult } from '../plan/plan-close.js'

function isDeliveryState(value: unknown): value is PlanCloseOptions['deliveryState'] {
  return value === 'GREEN' || value === 'YELLOW' || value === 'RED'
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return strings.length > 0 ? strings : undefined
}

function closureAction(result: PlanCloseResult): 'insert' | 'update' | 'unchanged' {
  if (result.closureInserted) return 'insert'
  if (result.closureUpdated) return 'update'
  return 'unchanged'
}

function formatChanges(result: PlanCloseResult): string[] {
  if (result.changes.length === 0) return ['  (none)']
  return result.changes.map(change => `  - Task ${change.taskNumber}: ${change.changedCheckboxCount}/${change.checkboxCount} checkbox(es) updated`)
}

export const PLAN_CLOSE_TOOL: Tool = {
  definition: {
    name: 'plan_close',
    description: `Preview or apply implementation plan closure updates.

### Usage
- Defaults to preview mode and does not write files
- Set apply=true to update the plan file after approval
- Only supports Markdown files under docs/superpowers/plans/
- Marks selected Task blocks complete and upserts execution closure text`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the plan Markdown file under docs/superpowers/plans/' },
        tasks: { type: 'string', description: 'Task selection such as 1, 1-3, 1,3-4, or all' },
        apply: { type: 'boolean', description: 'Write changes to the file (default false preview mode)' },
        verifiedCommands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verification commands to include in the closure summary',
        },
        deliveryState: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'], description: 'Delivery gate state to include in closure' },
        note: { type: 'string', description: 'Optional closure note' },
        updateClosure: { type: 'boolean', description: 'Whether to upsert execution status and closure (default true)' },
      },
      required: ['file_path', 'tasks'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const rawPath = params.input.file_path
    const tasks = params.input.tasks
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof tasks !== 'string' || !tasks.trim()) {
      return { content: 'Error: tasks is required', isError: true }
    }

    let filePath: string
    try {
      filePath = validatePath(params.cwd, rawPath)
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }

    const relativePath = relative(params.cwd, filePath).replaceAll('\\', '/')
    if (!relativePath.startsWith('docs/superpowers/plans/') || !relativePath.endsWith('.md')) {
      return { content: `Error: plan_close only supports Markdown files under docs/superpowers/plans/: ${relativePath}`, isError: true }
    }
    try {
      await stat(filePath)
    } catch {
      return { content: `Error: Plan file not found: ${filePath}`, isError: true }
    }

    const deliveryState = params.input.deliveryState
    if (deliveryState !== undefined && !isDeliveryState(deliveryState)) {
      return { content: `Error: deliveryState must be GREEN, YELLOW, or RED`, isError: true }
    }

    try {
      const result = closePlanMarkdown(await readFile(filePath, 'utf-8'), {
        tasks,
        verifiedCommands: asStringArray(params.input.verifiedCommands),
        deliveryState,
        note: typeof params.input.note === 'string' ? params.input.note : undefined,
        updateClosure: typeof params.input.updateClosure === 'boolean' ? params.input.updateClosure : undefined,
      })

      const action = closureAction(result)
      if (params.input.apply === true) {
        await writeFileAtomicAsync(filePath, result.content)
        return {
          content: [
            `Plan closed: ${relativePath}`,
            `Tasks: ${tasks}`,
            `Checkboxes updated: ${result.totalChangedCheckboxes}`,
            `Closure: ${action}`,
          ].join('\n'),
        }
      }

      return {
        content: [
          `Plan close preview: ${relativePath}`,
          `Tasks: ${tasks}`,
          `Checkboxes to update: ${result.totalChangedCheckboxes}`,
          `Closure: ${action}`,
          '',
          'Changes:',
          ...formatChanges(result),
          '',
          'No files changed. Re-run with apply=true to write the plan closure.',
        ].join('\n'),
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return params.input.apply === true
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
