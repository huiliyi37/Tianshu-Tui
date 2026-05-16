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
