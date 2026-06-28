/**
 * plan tool — unified plan lifecycle: submit for approval / close tasks.
 *
 * Merges the former plan_submit + plan_close into a single tool with a
 * discriminated action field. Reduces tool-count pressure on kernel budget
 * (≤25) and eliminates the "which plan tool do I use?" micro-decision.
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { writePlan, slugify } from '../plan/plan-store.js'
import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { relative } from 'node:path'
import { validatePath } from './path-validate.js'
import { closePlanMarkdown, type PlanCloseOptions, type PlanCloseResult } from '../plan/plan-close.js'

// ── plan_submit helpers ──

const warnedSlugs = new Set<string>()
const MERMAID_FENCE = /```\s*mermaid/i
const MISSING_DIAGRAM_SKELETON = `\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\``

// ── plan_close helpers ──

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
  return result.changes.map(change =>
    `  - Task ${change.taskNumber}: ${change.changedCheckboxCount}/${change.checkboxCount} checkbox(es) updated`,
  )
}

// ── unified tool ──

export const PLAN_TOOL: Tool = {
  definition: {
    name: 'plan',
    description: `Unified plan lifecycle tool — submit a plan for approval, or close completed tasks.

### Action: submit
Submit a completed implementation plan for user approval. The plan is persisted to \`.rivet/plans/<slug>.md\`.

### Action: close
Preview or apply implementation plan closure updates. Defaults to preview mode (no writes). Set apply=true to update the plan file.

Only supports Markdown files under docs/superpowers/plans/ or .rivet/plans/.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'close'],
          description: 'submit: create a plan for user approval. close: close completed plan tasks.',
        },
        // ── submit fields ──
        title: { type: 'string', description: '[submit] Short descriptive plan title (used for file slug)' },
        plan: { type: 'string', description: '[submit] Full plan in Markdown. Use Mermaid diagrams, code snippets, tables.' },
        // ── close fields ──
        file_path: { type: 'string', description: '[close] Path to the plan Markdown file under docs/superpowers/plans/' },
        tasks: { type: 'string', description: '[close] Task selection such as 1, 1-3, 1,3-4, or all' },
        apply: { type: 'boolean', description: '[close] Write changes to the file (default false preview mode)' },
        verifiedCommands: {
          type: 'array', items: { type: 'string' },
          description: '[close] Verification commands to include in the closure summary',
        },
        deliveryState: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'], description: '[close] Delivery gate state' },
        note: { type: 'string', description: '[close] Optional closure note' },
        updateClosure: { type: 'boolean', description: '[close] Whether to upsert execution status and closure (default true)' },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const action = params.input.action

    if (action === 'submit') {
      return planSubmitExecute(params)
    }
    if (action === 'close') {
      return planCloseExecute(params)
    }
    return { content: `Error: unknown action "${action}". Use "submit" or "close".`, isError: true }
  },

  requiresApproval(): boolean {
    // Plan closure only touches plan markdown (checkboxes + closure section) under
    // docs/superpowers/plans/ or .rivet/plans/. It is path-validated and reversible,
    // so we skip the approval gate to avoid interrupting the automated close flow.
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

// ── submit implementation ──

async function planSubmitExecute(params: ToolCallParams): Promise<ToolResult> {
  const title = params.input.title
  const planContent = params.input.plan

  if (typeof title !== 'string' || !title.trim()) {
    return { content: 'Error: title is required', isError: true }
  }
  if (typeof planContent !== 'string' || !planContent.trim()) {
    return { content: 'Error: plan is required', isError: true }
  }

  const slug = slugify(title)

  if (!MERMAID_FENCE.test(planContent) && !warnedSlugs.has(slug)) {
    warnedSlugs.add(slug)
    return {
      content: [
        `⚠️ Plan not yet saved — it has no Mermaid diagram.`,
        '',
        `A good plan visualizes architecture or data flow. Add one diagram (even just the core 3-5 nodes) and resubmit. Copy this skeleton and replace the node text:`,
        '',
        MISSING_DIAGRAM_SKELETON,
        '',
        `Shapes: (rounded)=input/user · [[subroutine]]=agent · {{hexagon}}=LLM · [(cylinder)]=store · {rhombus}=decision. Edges: --> read · ==> write · -.-> async/event.`,
        '',
        `If a diagram is genuinely unnecessary for this task, resubmit \`plan\` as-is (same title) and it will be saved.`,
      ].join('\n'),
      isError: true,
    }
  }

  const fullContent = `# ${title.trim()}\n\n${planContent.trim()}\n`

  try {
    const relativePath = await writePlan(params.cwd, slug, fullContent)
    return {
      content: [
        `✅ Plan submitted: **${title.trim()}**`,
        `File: \`${relativePath}\``,
        `Slug: \`${slug}\``,
        '',
        `The user will review and respond with:`,
        `- \`/plan-approve ${slug}\` — approve and start execution`,
        `- \`/plan-reject ${slug}\` — reject with feedback`,
        `- \`/plan-list\` — list all plans`,
        '',
        `**Wait here — do not proceed until the user approves.**`,
      ].join('\n'),
    }
  } catch (err) {
    return {
      content: `Error writing plan: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// ── close implementation ──

async function planCloseExecute(params: ToolCallParams): Promise<ToolResult> {
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
  const inSuperpowersPlans = relativePath.startsWith('docs/superpowers/plans/') && relativePath.endsWith('.md')
  const inRivetPlans = relativePath.startsWith('.rivet/plans/') && relativePath.endsWith('.md')
  if (!inSuperpowersPlans && !inRivetPlans) {
    return { content: `Error: plan close only supports docs/superpowers/plans/ or .rivet/plans/: ${relativePath}`, isError: true }
  }
  try { await stat(filePath) } catch {
    return { content: `Error: Plan file not found: ${filePath}`, isError: true }
  }

  const deliveryState = params.input.deliveryState
  if (deliveryState !== undefined && !isDeliveryState(deliveryState)) {
    return { content: 'Error: deliveryState must be GREEN, YELLOW, or RED', isError: true }
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
      if (params.onPlanClosed) {
        params.onPlanClosed({
          planFile: relativePath,
          tasks,
          deliveryState: deliveryState ?? 'GREEN',
          totalChangedCheckboxes: result.totalChangedCheckboxes,
        })
      }

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
}

// ── Backward-compat exports: callers in default-registry and elsewhere expect
//    the old split-tool constants. Both resolve to the same PLAN_TOOL instance.
export const PLAN_SUBMIT_TOOL = PLAN_TOOL
export const PLAN_CLOSE_TOOL = PLAN_TOOL
