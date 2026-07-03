/**
 * TaskPlanner — heuristic goal decomposition into a TaskGraph DAG.
 *
 * Receives a high-level objective and produces structured subtasks with
 * dependencies inferred from task kind and depth layer.
 */

import { classifyTaskDepth, type TaskContract, type TaskDepthLayer } from '../context/task-contract.js'
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

const REFACTOR_PATTERN = /refactor|重构|rename|extract|move|迁移/i

/** Self-containment directive appended to every shard. Each capable worker runs
 *  the FULL loop (implement + tsc/lint/tests) inside its own context, instead of
 *  leaving cleanup to separate role workers — that is what kills the old vertical
 *  pipeline (explore→patch→import→test→lint→type→verify). */
const SHARD_SELF_VERIFY =
  '\n\n本分片自包含:实现改动后,在本分片范围内自行运行 tsc / lint / 相关测试至通过,'
  + '不要把整理 import、修类型、修 lint、补测试拆给其他分片或留给后续。'

/** Top-level module path of a file (first two path segments, e.g. `src/tui`).
 *  Used to group scope files into orthogonal shards that touch disjoint files. */
function moduleKey(file: string): string {
  // Split on both separators — Windows tool inputs may carry backslashes.
  const parts = file.split(/[\\/]/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  return parts[0] ?? file
}

/** Group files into orthogonal module shards. Different modules → parallelizable
 *  shards; same module → one shard. Preserves first-seen order. */
function groupFilesByModule(files: string[]): Array<{ label: string; files: string[] }> {
  const map = new Map<string, string[]>()
  for (const f of files) {
    const key = moduleKey(f)
    const arr = map.get(key) ?? []
    arr.push(f)
    map.set(key, arr)
  }
  return [...map.entries()].map(([label, groupFiles]) => ({ label, files: groupFiles }))
}

function shardRisk(depth: TaskDepthLayer, fileCount: number): 'low' | 'medium' | 'high' {
  if (depth === 'system') return 'high'
  if (depth === 'wiring' || fileCount >= 2) return 'medium'
  return 'low'
}

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
 * Decompose an objective into a TaskGraph of HORIZONTAL, orthogonal shards.
 *
 * Each shard is a self-contained unit of work — one capable worker owns it
 * end-to-end (implement + run tsc/lint/tests to green in its own context). This
 * replaces the old VERTICAL role pipeline (explore→patch→import→test→lint→type
 * →verify), which fragmented one coherent change across many weak role workers
 * running serially.
 *
 * Splitting is by module boundary so shards touch disjoint files and run in
 * parallel; an optional upfront explore shard is added only for broad/structural
 * work that needs shared global context. Disjoint shards carry no cross-deps;
 * overlap-with-ordering is the main controller's job (and is enforced downstream
 * by groupTeamTasks same-file serialization + the file-claim registry).
 *
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

  // Optional upfront exploration — only when shards need shared global context
  // (structural / cross-module / refactor / many-file work). Small single-module
  // work skips it: the shard worker explores its own area inline.
  const needsExplore = depth === 'system' || depth === 'wiring'
    || REFACTOR_PATTERN.test(objective) || files.length >= 4
  const baseDeps: string[] = []
  if (needsExplore) {
    const exploreObjective = depth === 'system'
      ? `Explore and map module boundaries, dependencies and blast radius for: ${objective}`
      : `Explore and map relevant code for: ${objective}`
    baseDeps.push(add({
      title: 'Explore codebase',
      objective: exploreObjective,
      profile: 'code_scout',
      kind: 'code_search',
      files,
      dependsOn: [],
      riskTier: 'low',
    }))
  }

  const groups = groupFilesByModule(files)
  if (groups.length <= 1) {
    // One self-contained shard — the worker handles the whole objective
    // (implement + verify) end-to-end in its own context.
    add({
      title: objective.length > 80 ? `${objective.slice(0, 77)}...` : objective,
      objective: objective + SHARD_SELF_VERIFY,
      profile: 'patcher',
      kind: 'patch_proposal',
      files,
      dependsOn: [...baseDeps],
      riskTier: shardRisk(depth, files.length),
    })
  } else {
    // Horizontal orthogonal shards — one self-contained worker per module,
    // touching disjoint files so they run in parallel.
    for (const group of groups) {
      add({
        title: `${group.label}: ${objective}`.slice(0, 80),
        objective: `${objective}\n\n本分片只负责模块 ${group.label} 的改动(文件:${group.files.join(', ')}),`
          + `与其他分片并行执行,不要改动本分片范围外的文件。${SHARD_SELF_VERIFY}`,
        profile: 'patcher',
        kind: 'patch_proposal',
        files: group.files,
        dependsOn: [...baseDeps],
        riskTier: shardRisk(depth, group.files.length),
      })
    }
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
