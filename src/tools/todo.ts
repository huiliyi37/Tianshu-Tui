import { z } from 'zod'
import type { Tool } from './types.js'
import { TodoStore } from './todo-store.js'
import type { TodoItem } from './todo-store.js'

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

const defaultStore = new TodoStore()

export function getTodos(): TodoItem[] {
  return defaultStore.read()
}

export function setTodos(todos: TodoItem[]): void {
  defaultStore.write(todos)
}

export function createTodoTool(store: TodoStore = defaultStore): Tool {
  return {
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
        const todos = store.read()
        if (todos.length === 0) {
          return { content: 'No todos. Use write action to create a list.' }
        }
        return { content: TodoStore.formatList(todos) }
      }

      store.write(data.todos)

      return { content: TodoStore.formatSummary(data.todos) }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const TODO_TOOL: Tool = createTodoTool()
