import type { TeamTask } from './team-plan.js'

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_WRITE_WORKERS = 2
export const MAX_READ_WORKERS = 3

export interface GroupingOptions {
  maxWriteWorkers?: number
  maxReadWorkers?: number
}

export interface TeamWave {
  id: string
  taskIds: string[]
  reason: string
  parallelLimit: number
  risk: 'low' | 'medium' | 'high'
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get all files touched by a task. */
function touchFiles(task: TeamTask): string[] {
  return task.touchSet.length > 0 ? task.touchSet : task.files
}

/** Check if a task is read-only (scout, reviewer). */
function isReadOnly(task: TeamTask): boolean {
  return task.profile === 'code_scout'
    || task.profile === 'doc_scout'
    || (task.profile === 'reviewer' && task.kind === 'review')
}

/** Check if two write tasks share any file (partial overlap). */
function hasFileOverlap(a: TeamTask, b: TeamTask): boolean {
  const aFiles = new Set(touchFiles(a))
  const bFiles = touchFiles(b)
  if (aFiles.size === 0 || bFiles.length === 0) return false
  return bFiles.some(f => aFiles.has(f))
}

/** Topological sort of tasks by dependsOn. Returns ordered task IDs. */
function topologicalSort(tasks: TeamTask[]): string[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const result: string[] = []

  function visit(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    const task = taskMap.get(id)
    if (task) {
      for (const dep of task.dependsOn) {
        if (taskMap.has(dep)) visit(dep)
      }
    }
    result.push(id)
  }

  for (const t of tasks) visit(t.id)
  return result
}

/** Check if a file is a test file for a given source file. */
function isTestFor(testFile: string, sourceFile: string): boolean {
  // src/agent/foo.ts → src/agent/__tests__/foo.test.ts
  // src/agent/foo.ts → src/__tests__/foo.test.ts  (flatter layout)
  const base = sourceFile.replace(/\.ts$/, '').replace(/\.tsx$/, '')
  const testBase = testFile.replace(/\.test\.ts$/, '').replace(/\.test\.tsx$/, '').replace(/\/__tests__/, '')
  return base === testBase
}

/**
 * Bind source+test pairs: if a patcher task's files are all test files
 * for another patcher task's source files, merge them.
 */
function bindSourceTestPairs(tasks: TeamTask[]): TeamTask[] {
  const result: TeamTask[] = []
  const consumed = new Set<string>()

  for (const task of tasks) {
    if (consumed.has(task.id)) continue
    consumed.add(task.id)

    const files = touchFiles(task)
    // Only look for test-only tasks to merge into this one
    let merged = false
    for (const other of tasks) {
      if (consumed.has(other.id)) continue
      if (other.profile !== 'patcher') continue
      const otherFiles = touchFiles(other)
      if (otherFiles.length === 0) continue

      // Check if other's files are all test files for this task's files
      const allTestPairs = otherFiles.every(of =>
        files.some(f => isTestFor(of, f))
      )
      if (allTestPairs) {
        consumed.add(other.id)
        const mergedFiles = [...new Set([...files, ...otherFiles])]
        result.push({
          ...task,
          files: mergedFiles,
          touchSet: mergedFiles,
          verification: [...task.verification, ...other.verification],
          objective: [task.objective, other.objective].join('\n'),
        })
        merged = true
        break
      }
    }

    if (!merged) {
      result.push(task)
    }
  }

  return result
}

// ── Main grouping function ─────────────────────────────────────────────────

/**
 * Group team tasks into execution waves respecting:
 * 1. Topological order of dependencies
 * 2. Same-file write tasks must serialize
 * 3. source+test pairs are bound into one task
 * 4. Read-only tasks can parallel with write tasks
 * 5. maxWriteWorkers / maxReadWorkers caps per wave
 */
export function groupTeamTasks(tasks: TeamTask[], options?: GroupingOptions): TeamWave[] {
  if (tasks.length === 0) return []

  const maxWrite = options?.maxWriteWorkers ?? MAX_WRITE_WORKERS
  const maxRead = options?.maxReadWorkers ?? MAX_READ_WORKERS

  // Bind source+test pairs
  const bound = bindSourceTestPairs(tasks)
  const taskMap = new Map(bound.map(t => [t.id, t]))

  // Topological order
  const topoOrder = topologicalSort(bound)

  const waves: TeamWave[] = []
  let waveCounter = 0
  const completed = new Set<string>()
  const remaining = [...topoOrder]

  while (remaining.length > 0) {
    // Find tasks whose dependencies are all completed
    const ready: string[] = []
    const notReady: string[] = []

    for (const id of remaining) {
      const task = taskMap.get(id)
      if (!task) { notReady.push(id); continue }

      const depsMet = task.dependsOn.every(dep =>
        completed.has(dep) || !taskMap.has(dep)
      )
      if (depsMet) {
        ready.push(id)
      } else {
        notReady.push(id)
      }
    }

    if (ready.length === 0) {
      // All remaining are blocked — force one through
      const forced = remaining[0]!
      waves.push({
        id: `W${++waveCounter}`,
        taskIds: [forced],
        reason: 'forced: circular dependency or unresolvable',
        parallelLimit: 1,
        risk: 'high',
      })
      completed.add(forced)
      remaining.shift()
      continue
    }

    // Partition ready tasks into write and read
    const writeReady: string[] = []
    const readReady: string[] = []

    for (const id of ready) {
      const task = taskMap.get(id)!
      if (isReadOnly(task)) {
        readReady.push(id)
      } else {
        writeReady.push(id)
      }
    }

    // Group write tasks: serialize same-file, cap at maxWrite
    const waveWriteTasks: string[] = []
    const writeFilesInWave = new Set<string>()
    const deferredWrites: string[] = []

    for (const id of writeReady) {
      const task = taskMap.get(id)!

      if (hasFileOverlapWithSet(task, writeFilesInWave)) {
        deferredWrites.push(id)
        continue
      }

      if (waveWriteTasks.length >= maxWrite) {
        deferredWrites.push(id)
        continue
      }

      waveWriteTasks.push(id)
      for (const f of touchFiles(task)) writeFilesInWave.add(f)
    }

    // Cap read tasks
    const waveReadTasks = readReady.slice(0, maxRead)
    const deferredReads = readReady.slice(maxRead)

    // Build wave
    const waveTaskIds = [...waveWriteTasks, ...waveReadTasks]
    if (waveTaskIds.length > 0) {
      const waveRisk = waveTaskIds.some(id => taskMap.get(id)?.riskTier === 'high') ? 'high'
        : waveTaskIds.some(id => taskMap.get(id)?.riskTier === 'medium') ? 'medium'
        : 'low'

      const writeCount = waveWriteTasks.length
      const readCount = waveReadTasks.length
      const reason = writeCount > 0 && readCount > 0
        ? `${writeCount} write + ${readCount} read tasks`
        : writeCount > 0
          ? `${writeCount} write tasks`
          : `${readCount} read tasks`

      waves.push({
        id: `W${++waveCounter}`,
        taskIds: waveTaskIds,
        reason,
        parallelLimit: waveTaskIds.length,
        risk: waveRisk,
      })

      for (const id of waveTaskIds) completed.add(id)
    }

    // Remaining = deferred writes + deferred reads + not-ready
    remaining.length = 0
    remaining.push(...deferredWrites, ...deferredReads, ...notReady)
  }

  return waves
}

function hasFileOverlapWithSet(task: TeamTask, filesInWave: Set<string>): boolean {
  const taskFiles = touchFiles(task)
  if (taskFiles.length === 0 || filesInWave.size === 0) return false
  return taskFiles.some(f => filesInWave.has(f))
}
