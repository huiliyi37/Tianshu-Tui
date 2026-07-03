import { z } from 'zod'
import type { Tool } from './types.js'
import { TodoStore } from './todo-store.js'
import type { TodoItem } from './todo-store.js'
import { detectDependencies, assessScopeRisk, buildScopeNotice } from './todo-deps.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { existsSync, readFileSync } from 'node:fs'
import { getSessionDir } from '../agent/session-persist.js'

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
// MULTI-SESSION: the desktop server injects a per-session store via
// `createDefaultToolRegistry(..., { todoStore })` (refs.todoStore = new
// TodoStore() per session), and turn-end/todo-reminder read that same store
// through `config.getTodos`. The TUI keeps `refs.todoStore = defaultStore` so
// its `setTodoSession/loadTodos` persistence and session-switch behavior are
// unchanged. This `defaultStore` therefore stays the single-session default
// and the fallback for any caller that does not inject its own store.
export const defaultStore = new TodoStore()

export function getTodos(): TodoItem[] {
  return defaultStore.read()
}

export function setTodos(todos: TodoItem[]): void {
  defaultStore.write(todos)
  persistTodos()
}

let todoSessionId: string | undefined
let todoCwd: string | undefined

export function setTodoSession(sessionId: string, cwd: string): void {
  todoSessionId = sessionId
  todoCwd = cwd
}

function todoPersistPath(): string | undefined {
  if (!todoSessionId || !todoCwd) return undefined
  return `${getSessionDir(todoCwd)}/${todoSessionId}.todos.json`
}

function persistTodos(): void {
  const path = todoPersistPath()
  if (!path) return
  try {
    writeFileAtomicSync(path, JSON.stringify(defaultStore.read(), null, 2) + '\n')
  } catch { /* best-effort */ }
}

export function loadTodos(sessionId: string, cwd: string): TodoItem[] | null {
  const path = `${getSessionDir(cwd)}/${sessionId}.todos.json`
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (Array.isArray(raw)) {
      defaultStore.write(raw as TodoItem[])
      return raw as TodoItem[]
    }
  } catch { /* ignore corrupted file */ }
  return null
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
      description: `Read and write the session task list — your goal decomposition. Use it PROACTIVELY.

Actions:
- write: Replace the ENTIRE list (full-replace, not a patch). Each item has id, content, status (pending/in_progress/completed). Always re-send completed items so they are not lost.
- read: Return the current list.

When to create/update (do it without being asked):
- A task needs 3+ distinct steps, or is non-trivial / multi-file.
- The user gives multiple tasks (a numbered or comma-separated list).
- Right after receiving new instructions — capture them as todos immediately, BEFORE starting work.

When NOT to use: a single trivial step (don't add ceremony to one-shot edits).

TDD discipline:
- For code tasks (not docs/config), the FIRST step of each task should be writing or updating a test (RED), then making it pass (GREEN). Structure your todos to reflect this: e.g. "Write test for X" → "Implement X" → "Refactor".
- This is NOT mandatory for: documentation, config changes, refactors with existing test coverage, or quick typo fixes.

Status rules:
- Mark a task in_progress BEFORE you start it; keep exactly ONE task in_progress at a time.
- Mark a task completed IMMEDIATELY when done — do not batch completions.
- Never silently drop or reset a completed item when rewriting the list.`,
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
      // 同步到 PlanExecutionTrace：首次写入会 seed，后续写入会同步状态。
      if (params.onPlanSteps && data.todos.length > 0) {
        params.onPlanSteps(data.todos.map(t => ({ id: t.id, content: t.content, status: t.status })))
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
