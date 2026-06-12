/**
 * TaskPlanner — heuristic goal decomposition into a TaskGraph DAG.
 *
 * Receives a high-level objective and produces structured subtasks with
 * dependencies inferred from task kind and depth layer.
 */

import { classifyTaskDepth, type TaskContract, type TaskDepthLayer } from '../context/task-contract.js'
import type { WorkOrderKind, WorkerProfile } from './work-order.js'
import {
  groupIntoWaves,
  renderTaskGraphSummary,
  type TaskGraph,
  type TaskGraphNode,
  validateTaskGraph,
} from './task-graph.js'

export interface PlanDecomposeInput {
  objective: string
  files?: string[]
  depthLayer?: TaskDepthLayer
  taskKinds?: string[]
}

const TEST_PATTERN = /\btest|TDD|测试|spec|coverage|单测|集成测试/i
const REVIEW_PATTERN = /review|审查|验收|verify|验证|check/i
const REFACTOR_PATTERN = /refactor|重构|rename|extract|move|迁移/i
const DOC_PATTERN = /doc|文档|readme|jsdoc|comment/i
const LINT_PATTERN = /lint|format|eslint|prettier|import.*sort|类型|type.*error|tsc/i

function inferDepth(input: PlanDecomposeInput): TaskDepthLayer {
  if (input.depthLayer) return input.depthLayer
  const contract: TaskContract = {
    id: 'plan',
    objective: input.objective,
    scope: { mentionedFiles: input.files ?? [] },
    constraints: [],
    successCriteria: [],
    status: 'planning',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
  }
  return classifyTaskDepth(contract, undefined, input.taskKinds)
}

function nextId(prefix: string, index: number): string {
  return `${prefix}${index}`
}

/**
 * Decompose an objective into a TaskGraph using verb/heuristic rules.
 * Does not call LLM — deterministic and fast for plan-then-execute bootstrap.
 */
export function decomposeObjective(input: PlanDecomposeInput): TaskGraph {
  const objective = input.objective.trim()
  const files = input.files ?? []
  const depth = inferDepth(input)
  const nodes: TaskGraphNode[] = []
  let seq = 1

  const add = (partial: Omit<TaskGraphNode, 'id'> & { id?: string }): string => {
    const id = partial.id ?? nextId('T', seq++)
    nodes.push({ ...partial, id })
    return id
  }

  const exploreId = add({
    title: 'Explore codebase',
    objective: `Explore and map relevant code for: ${objective}`,
    profile: 'code_scout',
    kind: 'code_search',
    files,
    dependsOn: [],
    riskTier: 'low',
  })

  let lastWriteId = exploreId

  if (REFACTOR_PATTERN.test(objective) || files.length >= 3) {
    const archId = add({
      title: 'Architecture analysis',
      objective: `Analyze module boundaries and impact for: ${objective}`,
      profile: 'architect',
      kind: 'code_search',
      files,
      dependsOn: [exploreId],
      riskTier: depth === 'system' ? 'high' : 'medium',
    })
    lastWriteId = archId
  }

  if (!REVIEW_PATTERN.test(objective) && !LINT_PATTERN.test(objective)) {
    const patchId = add({
      title: 'Implement changes',
      objective,
      profile: 'patcher',
      kind: 'patch_proposal',
      files,
      dependsOn: [lastWriteId],
      riskTier: depth === 'system' ? 'high' : files.length >= 2 ? 'medium' : 'low',
    })
    lastWriteId = patchId

    if (depth !== 'unit' || files.length >= 2) {
      add({
        title: 'Organize imports',
        objective: `Sort and clean imports for changed files: ${files.join(', ') || 'scope files'}`,
        profile: 'import_organizer',
        kind: 'patch_proposal',
        files,
        dependsOn: [patchId],
        riskTier: 'low',
      })
    }
  }

  if (TEST_PATTERN.test(objective) || depth !== 'unit') {
    add({
      title: 'Scaffold tests',
      objective: `Generate test skeletons for: ${files.join(', ') || objective}`,
      profile: 'test_scaffolder',
      kind: 'patch_proposal',
      files,
      dependsOn: [lastWriteId],
      riskTier: 'low',
    })
  }

  if (LINT_PATTERN.test(objective) || !REVIEW_PATTERN.test(objective)) {
    add({
      title: 'Fix lint issues',
      objective: `Run linter and fix violations in: ${files.join(', ') || 'changed files'}`,
      profile: 'lint_fixer',
      kind: 'patch_proposal',
      files,
      dependsOn: [lastWriteId],
      riskTier: 'low',
    })
    add({
      title: 'Fix type errors',
      objective: `Run tsc and fix type errors in: ${files.join(', ') || 'changed files'}`,
      profile: 'type_fixer',
      kind: 'patch_proposal',
      files,
      dependsOn: [lastWriteId],
      riskTier: 'low',
    })
  }

  if (DOC_PATTERN.test(objective)) {
    add({
      title: 'Sync documentation',
      objective: `Update docs and JSDoc to match code for: ${objective}`,
      profile: 'doc_syncer',
      kind: 'patch_proposal',
      files,
      dependsOn: [lastWriteId],
      riskTier: 'low',
    })
  }

  const verifyProfile: WorkerProfile = depth === 'system' ? 'adversarial_verifier' : 'verifier'
  add({
    title: 'Verify changes',
    objective: `Verify implementation for: ${objective}`,
    profile: verifyProfile,
    kind: 'verify',
    files,
    dependsOn: nodes.filter(n => n.profile !== 'code_scout' && n.profile !== 'architect').map(n => n.id),
    riskTier: depth === 'system' ? 'high' : 'medium',
  })

  if (REVIEW_PATTERN.test(objective)) {
    add({
      title: 'Code review',
      objective: `Review changes for: ${objective}`,
      profile: 'reviewer',
      kind: 'review',
      files,
      dependsOn: [exploreId],
      riskTier: 'medium',
    })
  }

  // Deduplicate verify deps — only depend on leaf write tasks
  const writeNodes = nodes.filter(n =>
    n.profile === 'patcher' || n.profile === 'lint_fixer' || n.profile === 'type_fixer'
    || n.profile === 'test_scaffolder' || n.profile === 'import_organizer' || n.profile === 'doc_syncer',
  )
  const verifyNode = nodes.find(n => n.kind === 'verify')
  if (verifyNode && writeNodes.length > 0) {
    verifyNode.dependsOn = [...new Set(writeNodes.map(n => n.id))]
  }

  const graph: TaskGraph = {
    mission: objective,
    nodes,
    createdAt: Date.now(),
  }

  const validation = validateTaskGraph(graph)
  if (!validation.valid) {
    // Strip dangling deps rather than fail — planner is advisory
    for (const node of graph.nodes) {
      const ids = new Set(graph.nodes.map(n => n.id))
      node.dependsOn = node.dependsOn.filter(d => ids.has(d))
    }
  }

  return graph
}

export function refinePlanAfterWave(
  graph: TaskGraph,
  completedIds: string[],
  failedIds: string[],
): TaskGraph {
  if (failedIds.length === 0) return graph

  const refined: TaskGraph = {
    ...graph,
    nodes: graph.nodes.map(node => {
      if (!failedIds.includes(node.id)) return node
      // Re-queue failed node with troubleshooter prepended
      return {
        ...node,
        dependsOn: [...new Set([...node.dependsOn, ...completedIds.filter(id => !failedIds.includes(id))])],
        objective: `[retry after failure] ${node.objective}`,
        riskTier: 'high' as const,
      }
    }),
  }

  // Insert diagnostic scout before first failed write task
  const firstFailed = refined.nodes.find(n => failedIds.includes(n.id))
  if (firstFailed && firstFailed.profile !== 'code_scout') {
    const diagId = nextId('TD', refined.nodes.length + 1)
    refined.nodes.unshift({
      id: diagId,
      title: 'Diagnose failure',
      objective: `Diagnose root cause for failed task: ${firstFailed.title}`,
      profile: 'troubleshooter',
      kind: 'code_search',
      files: firstFailed.files,
      dependsOn: [],
      riskTier: 'medium',
    })
    firstFailed.dependsOn = [...new Set([diagId, ...firstFailed.dependsOn])]
  }

  return refined
}

export { groupIntoWaves, renderTaskGraphSummary, validateTaskGraph }
