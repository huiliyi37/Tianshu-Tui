import type { Tool, ToolCallParams } from './types.js'
import { decomposeObjective, renderTaskGraphSummary } from '../agent/task-planner.js'
import { taskGraphToUnifiedPlan, unifiedPlanToTeamTasks, serializeUnifiedPlan, renderUnifiedPlanSummary, validateUnifiedPlan } from '../agent/unified-plan.js'
import { runTeamSkeleton } from '../agent/team-orchestrator.js'
import type { DelegationCoordinator } from '../agent/coordinator.js'
import type { TeamOrchestratorDeps, TeamRunInput } from '../agent/team-orchestrator.js'
import { storePlan } from '../agent/plan-store.js'
import { classifyTaskDepth, classifyPlanMethodology, type TaskContract } from '../context/task-contract.js'
import { setTodos } from './todo.js'
import type { TodoItem } from './todo-store.js'
import { readFile } from 'node:fs/promises'
import type { TaskGraph, TaskGraphNode } from '../agent/task-graph.js'

const FULL_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-14-plan-methodology-template.md'
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
  const methodology = classifyPlanMethodology(contract, depth)

  const templatePath = methodology === 'full' ? FULL_TEMPLATE_PATH : LIGHTWEIGHT_TEMPLATE_PATH
  const templateType = methodology === 'full' ? '完整版（9阶段）' : '轻量版（5阶段）'

  return [
    '## 计划方法论路由',
    '',
    `任务深度: ${depth} | 推荐模板: ${methodology} | ${templateType}`,
    `模板路径: ${templatePath}`,
    '',
    methodology === 'full'
      ? '必须包含: 安全不变量、触发路径清单、双门对齐数据流图。系统边界标定和跨模块协调说明不可省略。'
      : '本任务 scope 内聚，单模块边界内变更，聚焦核心改动与验证即可。',
    '',
    '如用户已显式指定模板，以用户指定为准。',
  ].join('\n')
}

export function createPlanTaskTool(deps: {
  getCoordinator: () => DelegationCoordinator | null
  getSessionTurn?: () => number | undefined
  getSessionId?: () => string | undefined
  /** Optional: pass through telemetry hooks from bootstrap. */
  recordTeamWaveTelemetry?: TeamOrchestratorDeps['recordTeamWaveTelemetry']
  recordTeamSchedulerShadow?: TeamOrchestratorDeps['recordTeamSchedulerShadow']
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

      // Populate todo store so the PlanExecutionTrace baseline is immediately
      // seeded (U6: trace captures steps from the first todo write). Skip the
      // "verify" node (task-graph.ts always appends one) — it's a post-hoc
      // gate, not a user-facing step.
      const leafNodes = graph.nodes.filter(n => n.kind !== 'verify')
      if (leafNodes.length > 0) {
        const todoItems: TodoItem[] = leafNodes.map(n => ({
          id: n.id,
          content: n.title,
          status: 'pending' as const,
        }))
        setTodos(todoItems)
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
      storePlan(serializeUnifiedPlan(plan))

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

      // Step 4: execute via team orchestrator
      const coordinator = deps.getCoordinator()
      if (!coordinator) {
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\nError: coordinator not available for execution`,
          isError: true,
        }
      }

      const tasks = unifiedPlanToTeamTasks(plan)
      const input: TeamRunInput = {
        mode: 'standard',
        objective,
        tasks,
        maxParallel: 3,
        parentTurnId: `plan:${params.toolUseId ?? Date.now()}`,
        abortSignal: params.abortSignal,
      }

      const orchestratorDeps: TeamOrchestratorDeps = {
        delegateBatch: (requests, policy, abortSignal, onProgress) =>
          coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
        recordTeamWaveTelemetry: deps.recordTeamWaveTelemetry,
        recordTeamSchedulerShadow: deps.recordTeamSchedulerShadow,
        sessionId: deps.getSessionId?.(),
      }

      try {
        const summary = await runTeamSkeleton(input, orchestratorDeps)
        const guidance = buildMethodologyGuidance(objective, files ?? [])
        const todoNote = leafNodes.length > 0
          ? `\n\n✅ Todo list 已同步 (${leafNodes.length} 项)。`
          : ''
        return { content: `${renderUnifiedPlanSummary(plan)}\n\n${guidance}${todoNote}\n\n${summary.packet}` }
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
