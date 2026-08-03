import { z } from 'zod'

/** 模型可见空清单文案——todo.ts / formatList 共用，勿改成另一份字面量。 */
export const TODO_EMPTY_RESULT = '暂无待办。请用 write 动作创建清单。'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
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
 */
export interface TodoRegressionStats {
  /** todo writes seen this session — the denominator. Without it a raw count of
   *  regressions says nothing: 3 regressions in 5 writes and in 500 differ. */
  writes: number
  /** writes that reset or dropped at least one previously completed item */
  regressedWrites: number
  /** individual completed items regressed, summed across writes */
  regressedItems: number
}

export class TodoStore {
  private todos: TodoItem[] = []
  private regressionStats: TodoRegressionStats = { writes: 0, regressedWrites: 0, regressedItems: 0 }

  read(): TodoItem[] {
    return [...this.todos]
  }

  /**
   * Detect items that were `completed` in the current list but are being
   * reset to a non-completed status (or dropped entirely) by an incoming write.
   *
   * The `todo` tool is full-replace only, so after compaction discards the todo
   * tool messages the model rebuilds the list from lossy memory and silently
   * re-sends finished items as `pending` — causing re-execution of done work
   * ("todo 退回重做"). Surfacing this lets the tool warn the model so it can
   * self-correct. (root-cause analysis 2026-06-05, Thread 3)
   *
   * Returns the human-readable contents of regressed items (empty if none).
   */
  detectRegressions(incoming: TodoItem[]): string[] {
    const completedNow = this.todos.filter(t => t.status === 'completed')
    if (completedNow.length === 0) return []
    const incomingById = new Map(incoming.map(t => [t.id, t]))
    const regressed: string[] = []
    for (const done of completedNow) {
      const next = incomingById.get(done.id)
      if (!next) {
        regressed.push(`${done.content}（已从清单移除）`)
      } else if (next.status !== 'completed') {
        regressed.push(`${done.content}（completed → ${next.status}）`)
      }
    }
    return regressed
  }

  /**
   * Record one write and whatever `detectRegressions` found for it. Kept separate
   * from `detectRegressions` so that query stays free of side effects, and separate
   * from `write` so a caller that skips the detection can't silently inflate the
   * denominator with writes it never checked.
   */
  recordWrite(regressed: readonly string[]): void {
    this.regressionStats.writes++
    if (regressed.length > 0) {
      this.regressionStats.regressedWrites++
      this.regressionStats.regressedItems += regressed.length
    }
  }

  getRegressionStats(): TodoRegressionStats {
    return { ...this.regressionStats }
  }

  write(todos: TodoItem[]): void {
    const parsed = z.array(todoItemSchema).safeParse(todos)
    if (!parsed.success) {
      throw new Error(`Invalid todos: ${parsed.error.message}`)
    }
    this.todos = [...parsed.data]
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
