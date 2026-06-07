import { z } from 'zod'
import type { Tool } from './types.js'
import { TodoStore } from './todo-store.js'
import type { TodoItem } from './todo-store.js'
import { detectDependencies, computeMaxDepth, findExecutable, buildDepAnnotation } from './todo-deps.js'

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

      // Warn (don't block) when this write resets or drops a previously
      // completed item — the signature of post-compaction memory loss. A
      // legitimate re-open is still allowed; the model just gets told so it
      // can confirm rather than silently redo finished work. (Thread 3)
      const regressions = store.detectRegressions(data.todos)

      store.write(data.todos)

      const summary = TodoStore.formatSummary(data.todos)
      let content = summary

      // Scope gate: detect dependencies and narrow focus
      const deps = detectDependencies(data.todos)
      const maxDepth = computeMaxDepth(deps)
      const pendingCount = data.todos.filter(t => t.status === 'pending').length

      // Auto-focus: when pending > 5 or dependency depth > 3, mark the
      // first executable item as the current focus
      const SCOPE_PENDING_THRESHOLD = 5
      const SCOPE_DEPTH_THRESHOLD = 3
      const needsFocus = pendingCount > SCOPE_PENDING_THRESHOLD || maxDepth > SCOPE_DEPTH_THRESHOLD

      if (needsFocus || deps.some(d => d.dependsOn.length > 0)) {
        const executable = findExecutable(data.todos, deps)
        const focusId = executable.length > 0 ? executable[0]!.id : null
        const annotation = buildDepAnnotation(data.todos, deps, needsFocus ? focusId : null)
        if (annotation) {
          content += '\n\n' + annotation
        }
      }

      if (regressions.length > 0) {
        const warn = regressions.map(r => `  - ${r}`).join('\n')
        content = `⚠️ ${regressions.length} previously-completed item(s) were reset or dropped:\n${warn}\n\n`
            + `If this was unintentional (e.g. rebuilding the list from memory after a long task), `
            + `re-mark them as completed. Do NOT redo finished work.\n\n${content}`
      }

      return { content }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const TODO_TOOL: Tool = createTodoTool()
