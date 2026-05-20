/**
 * Failure Journal — 天璇修正 #5
 *
 * 系统化记录 Layer 3 失败案例（脚手架未能帮助模型突破 80 分的场景）。
 * 用于检测锚定（anchoring）和返工（rework）模式。
 *
 * 设计原则：
 * - 只记录失败，不记录成功（成功案例在 playbook 中）
 * - 每条记录包含：turn, tool, error, context, hypothesis
 * - 支持模式检测：anchoring（同文件 3+ 次修改）、rework（同任务 2+ 次返工）
 */

export interface FailureEntry {
  turn: number
  tool: string
  target?: string
  error: string
  context: string
  hypothesis?: string
  timestamp: number
}

export interface FailurePattern {
  type: 'anchoring' | 'rework'
  count: number
  evidence: FailureEntry[]
  suggestion: string
}

export interface FailureJournal {
  record(entry: Omit<FailureEntry, 'timestamp'>): void
  getEntries(): FailureEntry[]
  detectPatterns(): FailurePattern[]
  getRecentEntries(count: number): FailureEntry[]
  clear(): void
}

const ANCHORING_THRESHOLD = 3  // same file modified 3+ times
const REWORK_THRESHOLD = 2     // same task reworked 2+ times
const MAX_ENTRIES = 100

export function createFailureJournal(): FailureJournal {
  const entries: FailureEntry[] = []

  function record(entry: Omit<FailureEntry, 'timestamp'>): void {
    entries.push({ ...entry, timestamp: Date.now() })
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES)
    }
  }

  function getEntries(): FailureEntry[] {
    return [...entries]
  }

  function getRecentEntries(count: number): FailureEntry[] {
    return entries.slice(-count)
  }

  function detectPatterns(): FailurePattern[] {
    const patterns: FailurePattern[] = []

    // Anchoring: same file modified 3+ times
    const byTarget = new Map<string, FailureEntry[]>()
    for (const entry of entries) {
      if (entry.target) {
        const existing = byTarget.get(entry.target) ?? []
        existing.push(entry)
        byTarget.set(entry.target, existing)
      }
    }
    for (const [target, failures] of byTarget) {
      if (failures.length >= ANCHORING_THRESHOLD) {
        patterns.push({
          type: 'anchoring',
          count: failures.length,
          evidence: failures,
          suggestion: `文件 ${target} 被修改 ${failures.length} 次 — 可能存在锚定。建议：换一个方向，或者让用户介入。`,
        })
      }
    }

    // Rework: same task context reworked 2+ times
    const byContext = new Map<string, FailureEntry[]>()
    for (const entry of entries) {
      const existing = byContext.get(entry.context) ?? []
      existing.push(entry)
      byContext.set(entry.context, existing)
    }
    for (const [context, failures] of byContext) {
      if (failures.length >= REWORK_THRESHOLD) {
        patterns.push({
          type: 'rework',
          count: failures.length,
          evidence: failures,
          suggestion: `任务 "${context.slice(0, 50)}" 返工 ${failures.length} 次 — 可能存在返工循环。建议：重新审视任务理解。`,
        })
      }
    }

    return patterns
  }

  function clear(): void {
    entries.length = 0
  }

  return { record, getEntries, detectPatterns, getRecentEntries, clear }
}
