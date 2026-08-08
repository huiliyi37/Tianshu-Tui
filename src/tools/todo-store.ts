import { z } from 'zod'

/** 模型可见空清单文案——todo.ts / formatList 共用，勿改成另一份字面量。 */
export const TODO_EMPTY_RESULT = '暂无待办。请用 write 动作创建清单。'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
  /**
   * 进行中的现在时说法（「修复认证 bug」对「修复认证 bug」的祈使式 content）。
   * 可选——缺席时渲染回退到 `content`，老会话与不填这项的调用方都不受影响。
   * 对标 Claude Code 的 activeForm：状态带里念出来的是「正在做什么」。
   */
  activeForm: z.string().min(1).optional(),
})

export type TodoItem = z.infer<typeof todoItemSchema>

/**
 * Cumulative counters behind the "todo 退回率" baseline.
 *
 * `detectRegressions` is the only outcome-side detector in this repo that observes
 * whether the model actually retains its own task state — everything else measures
 * whether context was *injected*, not whether it *worked*. Its trigger used to go
 * nowhere: the warning was rendered into one tool result and then dropped, so the
 * rate was unknowable across sessions.
 *
 * v2（主控可靠性闭环 Wave 1）：删除完成项只计 `retiredCompletedItems`（主动退休，
 * 波次切换的正常形态），不再算 regression；同一项随后以 pending/in_progress
 * 重现（同 ID 或同内容指纹）才计 regression。旧会话 meta 无 detectorVersion
 * 字段 → 按 legacy v1 语义读，不与 v2 汇总混算。
 */
export interface TodoRegressionStats {
  /** todo writes seen this session — the denominator. Without it a raw count of
   *  regressions says nothing: 3 regressions in 5 writes and in 500 differ. */
  writes: number
  /** writes that reset or dropped at least one previously completed item */
  regressedWrites: number
  /** individual completed items regressed, summed across writes */
  regressedItems: number
  /** v2 检测器版本标记（1 = legacy：删除完成项也算回归；2 = 本版）。 */
  detectorVersion: 2
  /** 主动退休的已完成项数（删除完成项，非回归）。 */
  retiredCompletedItems: number
}

/** detectRegressions 的 v2 返回——regressed 与 retired 分开，只有前者触发警告。 */
export interface TodoDetection {
  /** 真实重开（completed → pending/in_progress，含退休后同内容重现）——警告只对它们发。 */
  regressed: string[]
  /** 主动退休（删除完成项）——只累计 retiredCompletedItems，不警告。 */
  retired: string[]
}

/** 内容指纹：规范化全文。换 ID 但同内容重现靠它识别。 */
function fingerprint(content: string): string {
  return content.trim().toLowerCase()
}

/** tombstone 上限——防失控增长（会话内退休项一般远小于此）。 */
const MAX_TOMBSTONES = 200

export class TodoStore {
  private todos: TodoItem[] = []
  /** 退休 tombstone：已完成项 id → 内容指纹。删除完成项时写入；completed 重现或
   *  指纹消费（同内容以非 completed 重现）时清除。 */
  private tombstones = new Map<string, string>()
  private regressionStats: TodoRegressionStats = {
    writes: 0, regressedWrites: 0, regressedItems: 0,
    detectorVersion: 2, retiredCompletedItems: 0,
  }

  read(): TodoItem[] {
    return [...this.todos]
  }

  /**
   * v2：检测「真实退回」——completed 项被重置为 pending/in_progress，或退休项
   * （tombstone）以同内容换 ID 重现。删除完成项归入 `retired`（主动退休），
   * 不警告——主动进入新波次、替换为不相关清单是正常形态，不是模型返工。
   *
   * 纯查询（无副作用）：tombstone 的写入/消费在 `write` 里完成。
   */
  detectRegressions(incoming: TodoItem[]): TodoDetection {
    const completedNow = this.todos.filter(t => t.status === 'completed')
    if (completedNow.length === 0 && this.tombstones.size === 0) {
      return { regressed: [], retired: [] }
    }
    const incomingById = new Map(incoming.map(t => [t.id, t]))
    const regressed: string[] = []
    const retired: string[] = []
    for (const done of completedNow) {
      const next = incomingById.get(done.id)
      if (!next) {
        retired.push(done.content)
      } else if (next.status !== 'completed') {
        regressed.push(`${done.content}（completed → ${next.status}）`)
      }
    }
    // 退休 tombstone 命中：同内容（任意新 ID）以非 completed 重现 → 真实重开
    for (const [, fp] of this.tombstones) {
      const match = incoming.find(t => fingerprint(t.content) === fp && t.status !== 'completed')
      if (match) {
        regressed.push(`${match.content}（退休后重新出现为 ${match.status}）`)
      }
    }
    return { regressed, retired }
  }

  /**
   * Record one write and whatever `detectRegressions` found for it. Kept separate
   * from `detectRegressions` so that query stays free of side effects, and separate
   * from `write` so a caller that skips the detection can't silently inflate the
   * denominator with writes it never checked.
   */
  recordWrite(detection: TodoDetection): void {
    this.regressionStats.writes++
    if (detection.regressed.length > 0) {
      this.regressionStats.regressedWrites++
      this.regressionStats.regressedItems += detection.regressed.length
    }
    this.regressionStats.retiredCompletedItems += detection.retired.length
  }

  getRegressionStats(): TodoRegressionStats {
    return { ...this.regressionStats }
  }

  write(todos: TodoItem[]): void {
    const parsed = z.array(todoItemSchema).safeParse(todos)
    if (!parsed.success) {
      throw new Error(`Invalid todos: ${parsed.error.message}`)
    }
    const next = [...parsed.data]

    // ── tombstone 维护（v2）──
    // 1. 退休：旧 completed 项不在新清单 → 入 tombstone（删除完成项）
    const nextIds = new Set(next.map(t => t.id))
    for (const done of this.todos) {
      if (done.status === 'completed' && !nextIds.has(done.id)) {
        this.tombstones.set(done.id, fingerprint(done.content))
      }
    }
    // 2. 消费/清除：completed 重现（正常重做完）→ 删 tombstone；
    //    非 completed 但指纹命中 → 消费（同一重开只警告一次，不重复刷屏）
    for (const t of next) {
      if (t.status === 'completed') {
        this.tombstones.delete(t.id)
        continue
      }
      const tFp = fingerprint(t.content)
      for (const [tid, fp] of this.tombstones) {
        if (fp === tFp) this.tombstones.delete(tid)
      }
    }
    // 3. 有界：防失控增长
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const keys = [...this.tombstones.keys()]
      for (const k of keys.slice(0, this.tombstones.size - MAX_TOMBSTONES)) {
        this.tombstones.delete(k)
      }
    }

    this.todos = next
  }

  static formatList(todos: TodoItem[]): string {
    if (todos.length === 0) return TODO_EMPTY_RESULT
    return todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content} (${t.status})`
    }).join('\n')
  }

  static formatSummary(todos: TodoItem[]): string {
    const completed = todos.filter(t => t.status === 'completed').length
    const total = todos.length
    const summary = `已更新：${completed}/${total} 已完成`
    const items = todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content}`
    })
    return `${summary}\n${items.join('\n')}`
  }
}
