/**
 * TaskGraph — structured DAG for plan-then-execute workflows.
 *
 * Nodes map to WorkOrder-shaped tasks; edges express dependencies.
 * Used by task-planner.ts and unified-plan.ts.
 */

import type { WorkOrderKind, WorkerProfile } from './work-order.js'

export interface TaskGraphNode {
  id: string
  title: string
  objective: string
  profile: WorkerProfile
  kind: WorkOrderKind
  files: string[]
  dependsOn: string[]
  riskTier: 'low' | 'medium' | 'high'
}

export interface TaskGraph {
  mission: string
  nodes: TaskGraphNode[]
  createdAt: number
}

export interface TaskGraphValidation {
  valid: boolean
  dangling: Array<{ taskId: string; missingDep: string }>
  cycles: string[][]
}

export function validateTaskGraph(graph: TaskGraph): TaskGraphValidation {
  const ids = new Set(graph.nodes.map(n => n.id))
  const dangling: TaskGraphValidation['dangling'] = []
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) dangling.push({ taskId: node.id, missingDep: dep })
    }
  }

  const cycles: string[][] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  function dfs(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const idx = stack.indexOf(id)
      if (idx >= 0) cycles.push(stack.slice(idx).concat(id))
      return
    }
    visiting.add(id)
    stack.push(id)
    const node = graph.nodes.find(n => n.id === id)
    if (node) {
      for (const dep of node.dependsOn) {
        if (ids.has(dep)) dfs(dep)
      }
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
  }

  for (const node of graph.nodes) dfs(node.id)

  return { valid: dangling.length === 0 && cycles.length === 0, dangling, cycles }
}

/** Topological order — dependencies before dependents. */
export function topologicalOrder(graph: TaskGraph): string[] {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  const visited = new Set<string>()
  const result: string[] = []

  function visit(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    const node = nodeMap.get(id)
    if (node) {
      for (const dep of node.dependsOn) {
        if (nodeMap.has(dep)) visit(dep)
      }
    }
    result.push(id)
  }

  for (const node of graph.nodes) visit(node.id)
  return result
}

/** Group nodes into execution waves (all deps satisfied within prior waves). */
export function groupIntoWaves(graph: TaskGraph): string[][] {
  const order = topologicalOrder(graph)
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  const assigned = new Map<string, number>()
  const waves: string[][] = []

  for (const id of order) {
    const node = nodeMap.get(id)!
    let wave = 0
    for (const dep of node.dependsOn) {
      const depWave = assigned.get(dep)
      if (depWave !== undefined && depWave >= wave) wave = depWave + 1
    }
    assigned.set(id, wave)
    if (!waves[wave]) waves[wave] = []
    waves[wave]!.push(id)
  }

  return waves.filter(Boolean)
}

export function renderTaskGraphSummary(graph: TaskGraph): string {
  const waves = groupIntoWaves(graph)
  const lines = [`Mission: ${graph.mission}`, `Tasks: ${graph.nodes.length}`, '']
  for (const [i, wave] of waves.entries()) {
    lines.push(`Wave ${i + 1}:`)
    for (const id of wave) {
      const node = graph.nodes.find(n => n.id === id)!
      const deps = node.dependsOn.length > 0 ? ` (deps: ${node.dependsOn.join(', ')})` : ''
      lines.push(`  ${node.id} [${node.profile}] ${node.title}${deps}`)
    }
  }
  return lines.join('\n')
}
