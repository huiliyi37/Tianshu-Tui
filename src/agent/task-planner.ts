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

/** Top-level module path of a file (directory up to three segments, e.g. `desktop/src/surfaces`).
 *  Used to group scope files into orthogonal shards that touch disjoint files.
 *  Two segments (e.g. `desktop/src`) collapses too many sub-modules into one
 *  monster shard when files span surfaces/state/components/locales — taking the
 *  directory (stripping the filename) up to three segments keeps sub-modules
 *  separate while keeping same-module files together. */
function moduleKey(file: string): string {
  // Normalize: strip leading './' and unify Windows backslashes.
  const normalized = file.replace(/^\.[\\/]/, '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  // Strip the filename: the module grouping is the directory, not the file.
  const dirParts = parts.length > 1 ? parts.slice(0, -1) : parts
  if (dirParts.length >= 3) return `${dirParts[0]}/${dirParts[1]}/${dirParts[2]}`
  if (dirParts.length === 2) return `${dirParts[0]}/${dirParts[1]}`
  return dirParts[0] ?? file
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

/** Path-like tokens with at least one directory segment and an extension
 *  (`toolkit2/slug.mjs`, `src/agent/loop.ts`). Requiring the directory part
 *  keeps prose like `node:test` / `.mjs` / bare words out. */
const MENTIONED_FILE_RE = /(?:[\w@.-]+\/)+[\w.-]+\.[a-zA-Z]\w{0,5}/g

/** Bare filenames immediately after a Chinese action verb — the most common
 *  pattern in free-form task descriptions ("创建 sound.ts", "扩展 persist.ts").
 *  Limited to a small fixed verb set to avoid matching arbitrary words that
 *  happen to end in `.ts`. Falls back when MENTIONED_FILE_RE finds nothing. */
const BARE_FILE_RE = /(?:创建|扩展|修改|新增|删除|重构|接入|实现|编写|更新|移除|替换)\s+([\w.-]+\.[a-zA-Z]\w{0,5})/g

/** Extract file paths mentioned in free text, de-duplicated, first-seen order. */
function extractMentionedFiles(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // Full paths first (dir/file.ext) — most reliable.
  for (const match of text.matchAll(MENTIONED_FILE_RE)) {
    const path = match[0]!
    if (!seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }
  // Fallback: bare filenames after Chinese action verbs.
  for (const match of text.matchAll(BARE_FILE_RE)) {
    const name = match[1]!
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

const NUMBERED_ITEM_RE = /^\s*\d{1,2}[.)、]\s*/

/** Split an objective into numbered-list items (`1. …` / `2) …` / `3、…`).
 *  Continuation lines attach to the preceding item. Returns [] when fewer
 *  than 2 items — a single "1." is prose, not a shard list. */
function splitNumberedItems(objective: string): string[] {
  const items: string[] = []
  let current: string[] | null = null
  for (const line of objective.split('\n')) {
    if (NUMBERED_ITEM_RE.test(line)) {
      if (current) items.push(current.join('\n').trim())
      current = [line.replace(NUMBERED_ITEM_RE, '')]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) items.push(current.join('\n').trim())
  const filtered = items.filter(Boolean)
  return filtered.length >= 2 ? filtered : []
}

/** Cap for objective-derived shards — beyond this the plan needs a real
 *  planner (or wave structure), not a heuristic burst. */
const MAX_ITEM_SHARDS = 8

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
  const explicitFiles = input.files ?? []

  // T5 fix (2026-07-30): when the caller passes no files — the normal shape for
  // new-file tasks, where scope files don't exist yet so the model reasonably
  // omits them — the old code fell straight into ONE monolith shard with
  // files:[]. That silently dropped the parallel-shard promise (e2e Run 4:
  // 7-task plan expectation collapsed to 单任务单波 + Scope Health leaked).
  // Recover the sharding signal from the objective text itself:
  //  a) a numbered list (≥2 items) → one shard per item, scoped to the files
  //     each item mentions;
  //  b) otherwise, file paths mentioned in prose → treat as scope files and
  //     let module grouping shard them.
  // Explicit `files` always wins — the caller declared scope, don't second-guess.
  const itemShards = explicitFiles.length === 0 ? splitNumberedItems(objective).slice(0, MAX_ITEM_SHARDS) : []
  const files = explicitFiles.length > 0
    ? explicitFiles
    : itemShards.length === 0 ? extractMentionedFiles(objective) : []
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
    || REFACTOR_PATTERN.test(objective) || files.length >= 4 || itemShards.length >= 4
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

  if (itemShards.length > 0) {
    // One self-contained shard per numbered item. Item-mentioned files become
    // the shard scope (may not exist yet — downstream `toBeCreated` semantics
    // handle new files); an item with no file mentions keeps an empty scope,
    // which still beats one monolith absorbing every item.
    for (const item of itemShards) {
      const itemFiles = extractMentionedFiles(item)
      const firstLine = item.split('\n')[0]!.trim()
      add({
        title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine,
        objective: `${objective}\n\n本分片只负责下面这个条目,与其他分片并行执行,不要改动本分片范围外的文件:\n${item}${SHARD_SELF_VERIFY}`,
        profile: 'patcher',
        kind: 'patch_proposal',
        files: itemFiles,
        dependsOn: [...baseDeps],
        riskTier: shardRisk(depth, itemFiles.length),
      })
    }
    const itemGraph: TaskGraph = { mission: objective, nodes, createdAt: Date.now() }
    const itemValidation = validateTaskGraph(itemGraph)
    if (!itemValidation.valid) {
      for (const node of itemGraph.nodes) {
        const ids = new Set(itemGraph.nodes.map(n => n.id))
        node.dependsOn = node.dependsOn.filter(d => ids.has(d))
      }
    }
    return itemGraph
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
