import { z } from 'zod'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
})

export type TodoItem = z.infer<typeof todoItemSchema>

export class TodoStore {
  private todos: TodoItem[] = []

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
        regressed.push(`${done.content} (dropped from list)`)
      } else if (next.status !== 'completed') {
        regressed.push(`${done.content} (completed → ${next.status})`)
      }
    }
    return regressed
  }

  write(todos: TodoItem[]): void {
    const parsed = z.array(todoItemSchema).safeParse(todos)
    if (!parsed.success) {
      throw new Error(`Invalid todos: ${parsed.error.message}`)
    }
    this.todos = [...parsed.data]
  }

  static formatList(todos: TodoItem[]): string {
    if (todos.length === 0) return 'No todos. Use write action to create a list.'
    return todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content} (${t.status})`
    }).join('\n')
  }

  static formatSummary(todos: TodoItem[]): string {
    const completed = todos.filter(t => t.status === 'completed').length
    const total = todos.length
    const summary = `Updated: ${completed}/${total} completed`
    const items = todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content}`
    })
    return `${summary}\n${items.join('\n')}`
  }
}
