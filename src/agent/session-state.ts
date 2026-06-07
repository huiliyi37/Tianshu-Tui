/**
 * SessionState — ephemeral per-session awareness tracker.
 *
 * NOT canonical memory. NOT persisted across sessions.
 * Lives in the dynamic appendix of the volatile block (changes every turn).
 *
 * Design goals:
 * - Give the model cross-turn awareness of what files it touched
 * - Track verification status without re-reading context
 * - Keep renderForVolatile() output under 500 chars for cache efficiency
 */

export interface FileEntry {
  lastRead: number
  artifactId: string
  modifiedByMe: boolean
}

export interface DecisionEntry {
  decision: string
  reason: string
  turn: number
}

export interface VerificationEntry {
  target: string
  status: 'passed' | 'failed' | 'not-run'
  verifiedAt: number
}

export interface FactEntry {
  fact: string
  evidence: string
  verifiedAt: number
}

export interface TaskListItem {
  id: string           // e.g., "P1", "T2"
  content: string      // e.g., "修复 loop.ts 中的内存泄露"
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  turnCreated: number
  turnUpdated: number
}

export interface SessionState {
  version: 1
  sessionId: string
  updatedAt: number
  task: {
    objective: string
    status: 'exploring' | 'planning' | 'executing' | 'verifying' | 'delivered' | 'blocked'
    plan?: string[]
    currentStep?: number
  }
  /** 从 Assistant 回复中提取的用户可感知任务列表，跨轮持久化，支持多轮回溯 */
  taskList: TaskListItem[]
  knownFacts: FactEntry[]
  decisions: DecisionEntry[]
  fileIndex: Record<string, FileEntry>
  verification: VerificationEntry[]
}

const MAX_DECISIONS = 20
const MAX_VERIFICATIONS = 30
const MAX_FACTS = 15
const MAX_TASK_ITEMS = 30
const VOLATILE_MAX_CHARS = 500

// Status markers an assistant may emit inline next to a task line.
// Order matters: more specific / terminal states are checked first.
const STATUS_MARKERS: Array<{ status: TaskListItem['status']; test: RegExp }> = [
  { status: 'completed', test: /(✓|✔|✅|\[x\]|\bdone\b|完成|已完成)/i },
  { status: 'blocked', test: /(⊗|🚫|\bblocked\b|阻塞|受阻|卡住)/i },
  { status: 'in_progress', test: /(◼|⏳|\[~\]|\bwip\b|\bin[ -]?progress\b|进行中|正在)/i },
]

/** Detect an explicit status marker on a task line; null means no signal. */
function detectStatusMarker(line: string): TaskListItem['status'] | null {
  for (const { status, test } of STATUS_MARKERS) {
    if (test.test(line)) return status
  }
  return null
}

export class SessionStateManager {
  private state: SessionState

  constructor(sessionId: string) {
    this.state = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      task: { objective: '', status: 'exploring' },
      taskList: [],
      knownFacts: [],
      decisions: [],
      fileIndex: {},
      verification: [],
    }
  }

  getSnapshot(): Readonly<SessionState> {
    // Return a frozen deep copy so callers cannot accidentally mutate
    // internal state (violates immutability invariant for snapshots).
    return JSON.parse(JSON.stringify(this.state)) as SessionState
  }

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  updateTask(
    objective: string,
    status: SessionState['task']['status'],
    plan?: string[],
    currentStep?: number,
  ): void {
    this.state.task = { objective, status, plan, currentStep }
    this.state.updatedAt = Date.now()
  }

  trackFileRead(path: string, artifactId: string): void {
    this.state.fileIndex[path] = {
      lastRead: Date.now(),
      artifactId,
      modifiedByMe: this.state.fileIndex[path]?.modifiedByMe ?? false,
    }
    this.state.updatedAt = Date.now()
  }

  trackFileModified(path: string): void {
    const existing = this.state.fileIndex[path]
    this.state.fileIndex[path] = {
      lastRead: existing?.lastRead ?? Date.now(),
      artifactId: existing?.artifactId ?? '',
      modifiedByMe: true,
    }
    this.state.updatedAt = Date.now()
  }

  recordDecision(decision: string, reason: string, turn: number): void {
    this.state.decisions.push({ decision, reason, turn })
    if (this.state.decisions.length > MAX_DECISIONS) {
      this.state.decisions = this.state.decisions.slice(-MAX_DECISIONS)
    }
    this.state.updatedAt = Date.now()
  }

  recordVerification(target: string, status: 'passed' | 'failed' | 'not-run'): void {
    const idx = this.state.verification.findIndex(v => v.target === target)
    const entry: VerificationEntry = { target, status, verifiedAt: Date.now() }
    if (idx >= 0) {
      this.state.verification[idx] = entry
    } else {
      this.state.verification.push(entry)
    }
    if (this.state.verification.length > MAX_VERIFICATIONS) {
      this.state.verification = this.state.verification.slice(-MAX_VERIFICATIONS)
    }
    this.state.updatedAt = Date.now()
  }

  recordFact(fact: string, evidence: string): void {
    this.state.knownFacts.push({ fact, evidence, verifiedAt: Date.now() })
    if (this.state.knownFacts.length > MAX_FACTS) {
      this.state.knownFacts = this.state.knownFacts.slice(-MAX_FACTS)
    }
    this.state.updatedAt = Date.now()
  }

  // ---------------------------------------------------------------------------
  // Task List — extracted from assistant replies, persisted across turns
  // ---------------------------------------------------------------------------

  /**
   * 从 Assistant 回复文本中提取任务列表（支持 Markdown 列表、编号、粗体等格式）。
   *
   * 合并语义（非覆盖）：已存在的 id 保留其 status/turnCreated，仅在检测到显式状态
   * 标记时更新 status，并刷新 content/turnUpdated；新 id 追加到尾部。这样跨多轮的
   * 计划不会被后续含新编号的回复整体冲掉。
   */
  extractTaskList(text: string, turn: number): TaskListItem[] {
    const parsed: Array<{ id: string; content: string; status: TaskListItem['status'] | null }> = []
    const lines = text.split('\n')

    // 匹配 Markdown 列表/编号模式: - P1: content, 1. P2: content, **P1**: content, ### P1. content
    const patterns = [
      /^[\s*\-\d.#]*\*?\*?([PpTtSs]\d+)\*?\*?[\s:\-.]+(.+)/,
      /^\s*\*?\*?([PpTtSs]\d+)\*?\*?[\s:\-.]+(.+)/,
      /\b([PpTtSs]\d+)\b\s*(?:-|=>|->|:|：)\s*(.+)/,
    ]

    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern)
        if (match?.[1] && match?.[2]) {
          const id = match[1].toUpperCase()
          const content = match[2].trim()
          // 过滤过短或纯符号内容
          if (content.replace(/[`*_\-\s]/g, '').length > 3 && !parsed.some(it => it.id === id)) {
            parsed.push({ id, content: content.slice(0, 160), status: detectStatusMarker(line) })
          }
          break // 一行只匹配第一个命中的模式
        }
      }
    }

    if (parsed.length === 0) return [...this.state.taskList]

    // 合并：保留既有项的 status/turnCreated（除非检测到显式状态标记），追加新项。
    const existingById = new Map(this.state.taskList.map(it => [it.id, it]))
    const merged: TaskListItem[] = this.state.taskList.map(it => ({ ...it }))

    for (const p of parsed) {
      const existing = existingById.get(p.id)
      if (existing) {
        const idx = merged.findIndex(m => m.id === p.id)
        merged[idx] = {
          ...existing,
          content: p.content,
          status: p.status ?? existing.status,
          turnUpdated: turn,
        }
      } else {
        merged.push({
          id: p.id,
          content: p.content,
          status: p.status ?? 'pending',
          turnCreated: turn,
          turnUpdated: turn,
        })
      }
    }

    // 容量上限：保留最近更新的项
    const capped = merged.length > MAX_TASK_ITEMS
      ? [...merged].sort((a, b) => b.turnUpdated - a.turnUpdated).slice(0, MAX_TASK_ITEMS)
      : merged

    this.state.taskList = capped
    this.state.updatedAt = Date.now()
    return [...capped]
  }

  /** 获取当前持久化的任务列表 */
  getTaskList(): Readonly<TaskListItem[]> {
    return this.state.taskList
  }

  /** 更新单个任务项的状态（不可变：返回新数组替换，不原地改写） */
  updateTaskListItem(id: string, status: TaskListItem['status'], turn: number): boolean {
    const idx = this.state.taskList.findIndex(it => it.id === id)
    if (idx < 0) return false
    this.state.taskList = this.state.taskList.map((it, i) =>
      i === idx ? { ...it, status, turnUpdated: turn } : it
    )
    this.state.updatedAt = Date.now()
    return true
  }

  // ---------------------------------------------------------------------------
  // Rendering — compact text for dynamic appendix injection
  // ---------------------------------------------------------------------------

  /** Render compact XML block for volatile block injection. Target: <500 chars. */
  renderForVolatile(): string {
    const s = this.state
    const lines: string[] = ['<session-state>']

    if (s.task.objective) {
      lines.push(`Task: ${s.task.objective} [${s.task.status}]`)
      if (s.task.plan && s.task.currentStep !== undefined) {
        lines.push(
          `Plan: step ${s.task.currentStep + 1}/${s.task.plan.length} — ${s.task.plan[s.task.currentStep] ?? ''}`,
        )
      }
    }

    const modifiedFiles = Object.entries(s.fileIndex)
      .filter(([, v]) => v.modifiedByMe)
      .map(([k]) => k)
    if (modifiedFiles.length > 0) {
      lines.push(`Modified: ${modifiedFiles.slice(0, 10).join(', ')}`)
    }

    if (s.decisions.length > 0) {
      lines.push('Decisions:')
      for (const d of s.decisions.slice(-5)) {
        lines.push(`  - ${d.decision}`)
      }
    }

    const failedTests = s.verification.filter(v => v.status === 'failed')
    if (failedTests.length > 0) {
      lines.push(`Failed: ${failedTests.map(v => v.target).join(', ')}`)
    }

    lines.push('</session-state>')
    let result = lines.join('\n')

    // Diffusion-aware truncation: keep under VOLATILE_MAX_CHARS
    if (result.length > VOLATILE_MAX_CHARS) {
      // Trim decision list first
      const closing = '\n</session-state>'
      const header = result.slice(0, result.indexOf('Decisions:'))
      if (header) {
        result = header.trimEnd() + closing
      }
      // If still too long, truncate with ellipsis
      if (result.length > VOLATILE_MAX_CHARS) {
        const maxContent = VOLATILE_MAX_CHARS - closing.length - 3 // '...'
        result = result.slice(0, maxContent) + '...' + closing
      }
    }

    return result
  }
}
