import type { TodoItem } from './todo-store.js'

export interface TodoDep {
  id: string
  dependsOn: string[]
}

/**
 * Dependency cue words that must precede a *bare-numeric* id for it to count
 * as a real dependency reference. Structured ids (with a letter prefix, e.g.
 * "T1", "task-2") are matched on their own; bare numbers like "1" require a
 * cue so that "还剩 1 个测试" / "fix 3 files" are NOT mistaken for edges.
 */
const DEP_CUE = /(?:基于|依赖|需先|先完成|完成后|建立在|after|depends?\s+on|requires?|blocked\s+by|builds?\s+on|based\s+on)/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does `content` reference `id` as a genuine dependency?
 * - Structured id (contains a letter): standalone-token match. "T1" matches
 *   "基于 T1" but not "T10"/"T12".
 * - Bare-numeric id: only when immediately preceded by a dependency cue word,
 *   to avoid counting quantities ("还剩 1 个") as edges.
 */
function referencesId(content: string, id: string): boolean {
  const escaped = escapeRe(id)
  if (/[A-Za-z]/.test(id)) {
    return new RegExp(`\\b${escaped}\\b`).test(content)
  }
  // pure-numeric id: require an explicit dependency cue right before it
  return new RegExp(`${DEP_CUE.source}\\s*#?${escaped}\\b`, 'i').test(content)
}

/**
 * Detect dependency edges between todo items by scanning content for
 * references to other todo IDs. The model naturally writes "基于 T1" or
 * "depends on Task2" in todo content — we extract these references.
 *
 * This is a static analysis (no NLP). Structured ids (T2, Task3, task-1) are
 * matched as standalone tokens; bare-numeric ids require an explicit
 * dependency cue word to avoid false positives on quantities.
 */
export function detectDependencies(todos: TodoItem[]): TodoDep[] {
  const ids = todos.map(t => t.id)
  return todos.map(t => {
    const deps: string[] = []
    for (const otherId of ids) {
      if (otherId === t.id) continue
      if (referencesId(t.content, otherId)) {
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
 * Order pending todos with executable items first, blocked items after —
 * WITHOUT dropping anything. Unlike findExecutable, every pending todo is
 * still surfaced; we only reorder so the model sees actionable work first.
 * This is what the working set (TaskState.remaining) uses, so a stale or
 * false-positive dependency edge can never make a real todo vanish.
 */
export function orderPendingByExecutability(todos: TodoItem[], deps: TodoDep[]): TodoItem[] {
  const executableIds = new Set(findExecutable(todos, deps).map(t => t.id))
  const pending = todos.filter(t => t.status === 'pending')
  const executable = pending.filter(t => executableIds.has(t.id))
  const blocked = pending.filter(t => !executableIds.has(t.id))
  return [...executable, ...blocked]
}

export type ScopeRiskLevel = 'none' | 'elevated' | 'high'

export interface ScopeRisk {
  level: ScopeRiskLevel
  pendingCount: number
  maxDepth: number
  blockedCount: number
  hasCycle: boolean
  reasons: string[]
}

const SCOPE_PENDING_THRESHOLD = 5
const SCOPE_DEPTH_THRESHOLD = 3

/**
 * Assess the scope risk of a todo list. This is the protective net for weaker
 * models that don't self-regulate the way tianquan-domain models do: when a
 * task looks large or deeply chained, we want the model to STOP and confirm
 * scope with the user rather than charge ahead and blow up its thinking.
 */
export function assessScopeRisk(todos: TodoItem[], deps: TodoDep[]): ScopeRisk {
  const pendingCount = todos.filter(t => t.status === 'pending').length
  const maxDepth = computeMaxDepth(deps)
  const hasCycle = maxDepth === Infinity
  const completedSet = new Set(
    todos.filter(t => t.status === 'completed').map(t => t.id)
  )
  const depMap = new Map(deps.map(d => [d.id, d.dependsOn]))
  let blockedCount = 0
  for (const t of todos) {
    if (t.status !== 'pending') continue
    const upstreams = depMap.get(t.id) ?? []
    if (upstreams.some(dep => !completedSet.has(dep))) blockedCount++
  }

  const reasons: string[] = []
  if (pendingCount > SCOPE_PENDING_THRESHOLD) {
    reasons.push(`${pendingCount} 个待办项一次性铺开（阈值 ${SCOPE_PENDING_THRESHOLD}）`)
  }
  if (hasCycle) {
    reasons.push('待办之间存在循环依赖，无法线性推进')
  } else if (maxDepth > SCOPE_DEPTH_THRESHOLD) {
    reasons.push(`依赖链深度 ${maxDepth}（阈值 ${SCOPE_DEPTH_THRESHOLD}）`)
  }

  let level: ScopeRiskLevel = 'none'
  if (hasCycle || maxDepth > SCOPE_DEPTH_THRESHOLD || pendingCount > SCOPE_PENDING_THRESHOLD * 2) {
    level = 'high'
  } else if (pendingCount > SCOPE_PENDING_THRESHOLD) {
    level = 'elevated'
  }

  return { level, pendingCount, maxDepth: hasCycle ? Infinity : maxDepth, blockedCount, hasCycle, reasons }
}

/**
 * Build the todo-tool response annotation. Its job is to surface risk and
 * nudge the model to PAUSE AND COMMUNICATE with the user when scope is large —
 * not to silently narrow the work. Blocked items are listed for visibility,
 * never hidden. Returns null when there's nothing worth saying.
 */
export function buildScopeNotice(
  todos: TodoItem[],
  deps: TodoDep[],
  risk: ScopeRisk,
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

  if (risk.level === 'none' && blocked.length === 0) return null

  const lines: string[] = []
  if (risk.level === 'high') {
    lines.push(`⚠️ 范围风险偏高：${risk.reasons.join('；')}。`)
    lines.push('建议立刻停下来与用户确认范围/优先级，拆为 2-3 wave 分批执行。每波 typecheck+test 通过后再继续下一波。若已与用户对齐，可继续。')
  } else if (risk.level === 'elevated') {
    lines.push(`提示：${risk.reasons.join('；')}。`)
    lines.push('建议提前拆为 2-3 wave 分批执行，每波 typecheck+test 通过后再做下一波——不要一次性铺开全部。若用户确认扁平执行，可继续。')
  }
  if (blocked.length > 0) {
    lines.push(`依赖未满足 (${blocked.length} 项，仍保留在列表中):`)
    lines.push(...blocked)
  }
  return lines.join('\n')
}
