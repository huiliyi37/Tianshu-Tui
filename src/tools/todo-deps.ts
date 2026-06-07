import type { TodoItem } from './todo-store.js'

export interface TodoDep {
  id: string
  dependsOn: string[]
}

/**
 * Detect dependency edges between todo items by scanning content for
 * references to other todo IDs. The model naturally writes "基于 T1" or
 * "depends on Task2" in todo content — we extract these references.
 *
 * This is a static analysis (no NLP). It catches explicit id references
 * like "T2", "Task3", "task-1" that appear in other items' content.
 */
export function detectDependencies(todos: TodoItem[]): TodoDep[] {
  const ids = todos.map(t => t.id)
  return todos.map(t => {
    const deps: string[] = []
    for (const otherId of ids) {
      if (otherId === t.id) continue
      // Match id as a standalone token (not substring of another word)
      // e.g. "T1" matches "基于 T1" but not "T10" or "T12"
      const escaped = otherId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`\\b${escaped}\\b`)
      if (re.test(t.content)) {
        deps.push(otherId)
      }
    }
    return { id: t.id, dependsOn: deps }
  })
}

/**
 * Compute the maximum dependency depth (longest chain).
 * Returns 0 for no dependencies, 1 for a single link, etc.
 * Returns Infinity if there's a cycle.
 */
export function computeMaxDepth(deps: TodoDep[]): number {
  const depMap = new Map(deps.map(d => [d.id, d.dependsOn]))
  const cache = new Map<string, number>()

  function depth(id: string, visiting: Set<string>): number {
    if (cache.has(id)) return cache.get(id)!
    if (visiting.has(id)) return Infinity // cycle
    visiting.add(id)
    const upstreams = depMap.get(id) ?? []
    if (upstreams.length === 0) {
      cache.set(id, 0)
      visiting.delete(id)
      return 0
    }
    let max = 0
    for (const up of upstreams) {
      const d = depth(up, visiting)
      if (d === Infinity) { cache.set(id, Infinity); visiting.delete(id); return Infinity }
      if (d + 1 > max) max = d + 1
    }
    cache.set(id, max)
    visiting.delete(id)
    return max
  }

  let result = 0
  for (const dep of deps) {
    const d = depth(dep.id, new Set())
    if (d === Infinity) return Infinity
    if (d > result) result = d
  }
  return result
}

/**
 * Filter todos to only those whose dependencies are all completed.
 * Returns the executable subset in original order.
 */
export function findExecutable(todos: TodoItem[], deps: TodoDep[]): TodoItem[] {
  const completedSet = new Set(
    todos.filter(t => t.status === 'completed').map(t => t.id)
  )
  const depMap = new Map(deps.map(d => [d.id, d.dependsOn]))

  return todos.filter(t => {
    if (t.status !== 'pending') return false
    const upstreams = depMap.get(t.id) ?? []
    return upstreams.every(dep => completedSet.has(dep))
  })
}

/**
 * Build a human-readable dependency annotation for the todo tool response.
 * Shows which items are blocked and what the current focus should be.
 */
export function buildDepAnnotation(
  todos: TodoItem[],
  deps: TodoDep[],
  focusId: string | null,
): string | null {
  const completedSet = new Set(
    todos.filter(t => t.status === 'completed').map(t => t.id)
  )
  const depMap = new Map(deps.map(d => [d.id, d.dependsOn]))
  const blocked: string[] = []

  for (const t of todos) {
    if (t.status !== 'pending') continue
    const upstreams = depMap.get(t.id) ?? []
    const unmet = upstreams.filter(dep => !completedSet.has(dep))
    if (unmet.length > 0) {
      blocked.push(`  ⛔ ${t.id} "${t.content.slice(0, 40)}" ← blocked by ${unmet.join(', ')}`)
    }
  }

  if (blocked.length === 0 && !focusId) return null

  const lines: string[] = []
  if (focusId) {
    const focusItem = todos.find(t => t.id === focusId)
    if (focusItem) {
      lines.push(`📌 当前焦点: ${focusId} — ${focusItem.content.slice(0, 60)}`)
      lines.push('  完成当前焦点后再推进下一项。不要并行处理多个设计。')
    }
  }
  if (blocked.length > 0) {
    lines.push(`依赖阻断 (${blocked.length} 项):`)
    lines.push(...blocked)
  }
  return lines.join('\n')
}
