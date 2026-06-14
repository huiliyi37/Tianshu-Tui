import { z } from 'zod'
import type { Tool } from './types.js'
import { TodoStore } from './todo-store.js'
import type { TodoItem } from './todo-store.js'
import { detectDependencies, assessScopeRisk, buildScopeNotice } from './todo-deps.js'

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

// Process-wide default store backing the convenience `getTodos`/`setTodos`
// helpers and the bare `TODO_TOOL` export. It is correct for the single-session
// CLI/TUI (one process == one session; `main.ts` wires the TUI todo panel via
// `setTodosProvider(() => getTodos())` and `turn-end.ts` reads `getTodos()`).
//
// KNOWN MULTI-SESSION LIMITATION: the desktop server (`src/server/serve.ts`)
// builds a fresh ToolRegistry per session but registers the shared `TODO_TOOL`
// singleton, so concurrent sessions in one process currently share this one
// list. True isolation means injecting a per-session store via
// `createTodoTool(new TodoStore())` AND routing the TUI/turn-end readers to that
// same store — a multi-session-isolation change tracked separately, not a local
// tweak (it touches every `createDefaultToolRegistry` caller).
const defaultStore = new TodoStore()

export function getTodos(): TodoItem[] {
  return defaultStore.read()
}

export function setTodos(todos: TodoItem[]): void {
  defaultStore.write(todos)
}

/**
 * `store` is per-AgentLoop (inject `new TodoStore()` for session isolation).
 * Note: `isConcurrencySafe: () => true` concerns intra-turn parallelism (the
 * tool has no filesystem side effects), NOT cross-session store sharing — that
 * isolation comes from injecting a distinct store per loop.
 */
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

      // U6/C1: the todo list IS the LLM's goal decomposition. Surface the
      // ordered descriptions to the loop, which seeds the PlanExecutionTrace
      // on the first write (idempotent — later status-update writes are a
      // no-op on the trace via withPlanSteps). Zero new tool, zero budget.
      if (params.onPlanSteps && data.todos.length > 0) {
        params.onPlanSteps(data.todos.map(t => t.content))
      }

      const summary = TodoStore.formatSummary(data.todos)
      let content = summary

      // Scope gate (protective net for non-tianquan models): assess whether
      // the task is large/deeply-chained and, if so, surface a notice nudging
      // the model to PAUSE AND CONFIRM scope with the user instead of charging
      // ahead. Blocked items are listed for visibility, never hidden.
      const deps = detectDependencies(data.todos)
      const risk = assessScopeRisk(data.todos, deps)
      const notice = buildScopeNotice(data.todos, deps, risk)
      if (notice) {
        content += '\n\n' + notice
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
