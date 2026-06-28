import type { Tool, ToolCallParams } from './types.js'
import { decomposeObjective, renderTaskGraphSummary } from '../agent/task-planner.js'
import { taskGraphToUnifiedPlan, unifiedPlanToTeamTasks, serializeUnifiedPlan, renderUnifiedPlanSummary, validateUnifiedPlan } from '../agent/unified-plan.js'
import type { DelegationCoordinator } from '../agent/coordinator.js'
import { executePlan, type PlanExecutorDeps, type PlanExecutorRun } from '../agent/plan-executor.js'
import { storePlan } from '../agent/plan-store.js'
import { classifyTaskDepth, type TaskContract } from '../context/task-contract.js'
import { setTodos } from './todo.js'
import type { TodoItem } from './todo-store.js'
import { readFile } from 'node:fs/promises'
import type { TaskGraph, TaskGraphNode } from '../agent/task-graph.js'

const BASE_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-28-plan-methodology-base.md'
const LIGHTWEIGHT_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-14-plan-methodology-lightweight.md'

// ── Plan file detection & checklist parsing (plan_task → team_orchestrate fast path) ──

const PLAN_PATH_RE = /(?:\.rivet\/knowledge\/|docs\/superpowers\/plans\/)[^\s]+\.md/

/** Extract a plan file path from objective text or files array.
 *  Returns null if no recognized plan file path is found. */
export function extractPlanPath(objective: string, files?: string[]): string | null {
  const match = objective.match(PLAN_PATH_RE)
  if (match) return match[0]
  if (files) {
    for (const f of files) {
      if (PLAN_PATH_RE.test(f)) return f
    }
  }
  return null
}

/** Parse unchecked checklist items from Markdown.
 *  Each `- [ ]` line becomes one item with text + extracted file paths.
 *  Checked items (`- [x]`) are skipped. */
export function parseChecklistItems(markdown: string): Array<{ text: string; files: string[] }> {
  const items: Array<{ text: string; files: string[] }> = []
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- \[ \] (.+)$/)
    if (!m) continue
    const text = m[1]!.trim()
    const fileRefs = text.match(/`([^`]+\.\w+)`/g) ?? []
    const files = fileRefs.map(f => f.replace(/`/g, ''))
    items.push({ text, files })
  }
  return items
}

/** Build a TaskGraph from parsed checklist items — each item becomes a patcher task. */
function buildTasksFromChecklist(
  items: Array<{ text: string; files: string[] }>,
  objective: string,
): TaskGraph {
  const nodes: TaskGraphNode[] = []
  let seq = 1
  for (const item of items) {
    const id = `P${seq++}`
    nodes.push({
      id,
      title: item.text.slice(0, 80),
      objective: `${item.text}\n\n只执行本 task，不扩展范围，不重写计划。`,
      profile: 'patcher' as const,
      kind: 'patch_proposal' as const,
      files: item.files,
      dependsOn: [],
      riskTier: 'medium' as const,
    })
  }
  return { mission: objective, nodes, createdAt: Date.now() }
}

// ── Methodology guidance ──

/**
 * Build a methodology guidance block for injection into plan_task output.
 * Pure function — never writes to static tool definitions (prefix-cache safe).
 */
function buildMethodologyGuidance(objective: string, files: string[]): string {
  const contract: TaskContract = {
    id: 'plan-task',
    objective,
    scope: { mentionedFiles: files },
    constraints: [],
    successCriteria: [],
    status: 'planning',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
  }
  const depth = classifyTaskDepth(contract)
  // 默认使用 Superpowers-based 基础模板；只有明确极小（unit 深度 + 不超过一个文件）才降级为轻量版。
  const useLightweight = depth === 'unit' && files.length <= 1
  const templatePath = useLightweight ? LIGHTWEIGHT_TEMPLATE_PATH : BASE_TEMPLATE_PATH
  const templateType = useLightweight ? '轻量版（5阶段）' : '基础模板（Superpowers writing-plans）'
  const note = useLightweight
    ? '本任务 scope 内聚，单模块边界内变更，聚焦核心改动与验证即可。'
    : '默认使用基础模板，强制四条纪律：① 至少一张 Mermaid 图；② TDD RED→GREEN；③ 探针先行；④ 瑶光反证（真实输入复现、取 exit code、方案 GREEN≠落地 GREEN）。安全/权限/沙箱/多 enforcement gate 任务追加安全附录。'

  return [
    '## 计划方法论路由',
    '',
    `任务深度: ${depth} | 推荐模板: ${templateType}`,
    `模板路径: ${templatePath}`,
    '',
    note,
    '',
    '如用户已显式指定模板，以用户指定为准。',
  ].join('\n')
}

export function createPlanTaskTool(deps: {
  getCoordinator: () => DelegationCoordinator | null
  /** Shared closed-loop execution kernel (same one team_orchestrate uses). */
  getExecutorDeps: () => PlanExecutorDeps
  getSessionTurn?: () => number | undefined
  getSessionId?: () => string | undefined
}): Tool {
  return {
    definition: {
      name: 'plan_task',
      description: `Decompose a high-level objective into a TaskGraph DAG and optionally execute it wave-by-wave.

Use for multi-step work that benefits from structured planning (refactors, feature work, verification pipelines).
Set execute: true to run the plan through the team orchestrator (same execution path as team_orchestrate).

Output is a UnifiedPlan JSON — pass it to team_orchestrate's planJson parameter for multi-wave continuation.`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'High-level goal to decompose' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional scope files',
          },
          execute: { type: 'boolean', description: 'Execute the plan after generation (default false)' },
        },
        required: ['objective'],
      },
    },

    async execute(params: ToolCallParams) {
      const objective = String(params.input.objective ?? '').trim()
      if (!objective) {
        return { content: 'Error: objective is required', isError: true }
      }

      const files = Array.isArray(params.input.files)
        ? (params.input.files as string[]).filter(f => typeof f === 'string')
        : undefined

      // Step 1: plan file detection fast-path — when objective/files reference a
      // Markdown plan, parse its checklist directly into patcher tasks instead of
      // running the generic decomposeObjective pipeline (scout→architect→…).
      let graph: TaskGraph
      const planPath = extractPlanPath(objective, files)
      if (planPath) {
        try {
          const markdown = await readFile(planPath, 'utf-8')
          const items = parseChecklistItems(markdown)
          if (items.length > 0) {
            graph = buildTasksFromChecklist(items, objective)
          } else {
            graph = decomposeObjective({ objective, files })
          }
        } catch {
          // File missing or unreadable → fallback
          graph = decomposeObjective({ objective, files })
        }
      } else {
        graph = decomposeObjective({ objective, files })
      }

      // Populate todo store and seed the PlanExecutionTrace baseline immediately.
      // Skip the "verify" node (task-graph.ts always appends one) — it's a post-hoc
      // gate, not a user-facing step.
      const leafNodes = graph.nodes.filter(n => n.kind !== 'verify')
      if (leafNodes.length > 0) {
        const todoItems: TodoItem[] = leafNodes.map(n => ({
          id: n.id,
          content: n.title,
          status: 'pending' as const,
        }))
        setTodos(todoItems)
        params.onPlanSteps?.(todoItems.map(t => ({ id: t.id, content: t.content, status: t.status })))
      }

      // Step 2: convert to UnifiedPlan
      const plan = taskGraphToUnifiedPlan(graph)

      // Step 3: validate
      const validation = validateUnifiedPlan(plan)
      if (!validation.valid) {
        const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
        return {
          content: `Plan validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}\n\n${renderTaskGraphSummary(graph)}`,
          isError: true,
        }
      }

      // Bridge: store the serialized plan so team_orchestrate can auto-consume
      // it without the model copy-pasting JSON between tool calls.
      storePlan(serializeUnifiedPlan(plan), params.sessionId)

      if (params.input.execute !== true) {
        // Return JSON + human-readable summary with methodology guidance
        const json = serializeUnifiedPlan(plan)
        const guidance = buildMethodologyGuidance(objective, files ?? [])
        const todoNote = leafNodes.length > 0
          ? `\n\n✅ Todo list 已同步 (${leafNodes.length} 项)。用 \`todo read\` 查看,完成后用 \`todo write\` 标记进度。`
          : ''
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n${guidance}${todoNote}\n\n---\n## UnifiedPlan JSON (pass to team_orchestrate as planJson)\n\`\`\`json\n${json}\n\`\`\``,
        }
      }

      // Step 4: execute via the shared plan executor — the SAME closed loop as
      // team_orchestrate, minus the review gate. plan_task's post-execution path
      // is the commit flow, whose post-commit auto review gate already covers the
      // diff; running a review-squadron here too would double-review. So
      // reviewGate:false — plan_task still gets dispatch + scope-health +
      // telemetry + reward/episode closure, just no review-squadron dispatch.
      const coordinator = deps.getCoordinator()
      if (!coordinator) {
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\nError: coordinator not available for execution`,
          isError: true,
        }
      }

      const tasks = unifiedPlanToTeamTasks(plan)
      try {
        const run: PlanExecutorRun = await executePlan(
          {
            mode: 'standard',
            objective,
            tasks,
            fromWave: 0,
            maxParallel: 3,
            sessionId: params.sessionId,
            parentTurnId: `plan:${params.toolUseId ?? Date.now()}`,
            reviewDepth: params.reviewDepth ?? 0,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            // Review handled by the post-commit auto gate — see comment above.
            reviewGate: false,
          },
          deps.getExecutorDeps(),
        )
        const guidance = buildMethodologyGuidance(objective, files ?? [])
        const todoNote = leafNodes.length > 0
          ? `\n\n✅ Todo list 已同步 (${leafNodes.length} 项)。`
          : ''
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n${guidance}${todoNote}\n\n${run.summary.packet}${run.notes.scopeHealthNote}${run.notes.deliverySynthesis}`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `${renderUnifiedPlanSummary(plan)}\n\nExecution failed: ${msg}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
