import { z } from 'zod'
import type { Tool } from './types.js'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
})

const todoActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('write'), todos: z.array(todoItemSchema) }),
])

type TodoItem = z.infer<typeof todoItemSchema>

let currentTodos: TodoItem[] = []

export function getTodos(): TodoItem[] {
  return [...currentTodos]
}

export function setTodos(todos: TodoItem[]): void {
  currentTodos = [...todos]
}

export const TODO_TOOL: Tool = {
  definition: {
    name: 'todo',
    description: `Read and write the session task list. Use this to track progress on multi-step tasks.
- write: Replace the entire todo list with a new one. Each item has id, content, and status (pending/in_progress/completed).
- read: Return the current todo list.

Always update the list when completing or starting a task.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'Read current todos or write a new list',
        },
        todos: {
          type: 'array',
          description: 'The complete todo list (only for write action)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for this task' },
              content: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: [...VALID_STATUSES], description: 'Task status' },
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['action'],
    },
  },

  async execute(params) {
    const parsed = todoActionSchema.safeParse(params.input)
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const data = parsed.data

    if (data.action === 'read') {
      if (currentTodos.length === 0) {
        return { content: 'No todos. Use write action to create a list.' }
      }
      const lines = currentTodos.map(t => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
        return `${icon} [${t.id}] ${t.content} (${t.status})`
      })
      return { content: lines.join('\n') }
    }

    currentTodos = data.todos

    const completed = data.todos.filter(t => t.status === 'completed').length
    const total = data.todos.length
    const summary = `Updated: ${completed}/${total} completed`
    const items = data.todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content}`
    })
    return { content: `${summary}\n${items.join('\n')}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
