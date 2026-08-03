import { z } from 'zod'
import type { Tool } from './types.js'
import { TodoStore, TODO_EMPTY_RESULT } from './todo-store.js'
import type { TodoItem, TodoRegressionStats } from './todo-store.js'
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

const acceptanceItemSchema = z.object({
  criterion: z.string().min(1),
  status: z.enum(['pending', 'met', 'blocked']),
  evidence: z.string().optional(),
})

const todoActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({
    action: z.literal('write'),
    todos: z.array(todoItemSchema),
    acceptance: z.array(acceptanceItemSchema).optional(),
  }),
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

/** Fallback accessor for callers without an injected store — mirrors `getTodos`. */
export function getTodoRegressionStats(): TodoRegressionStats {
  return defaultStore.getRegressionStats()
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
      description: `读写会话任务清单——你的目标分解。主动使用它。

Actions:
- write: 整体替换清单（全量替换，不是补丁）。每项含 id、content、status（pending/in_progress/completed）。已完成项也要重发，否则丢失。
- read: 返回当前清单。

何时创建/更新（不用等用户要求）：
- 任务需要 3 个以上不同步骤，或非平凡/跨多文件。
- 用户一次给多个任务（编号或逗号分隔的清单）。
- 收到新指令后立即建——先落成 todo，再开工。

何时不用：单步琐碎操作（一次性小编辑别加仪式）。

Plan mode 下：用 todo 跟踪调研步骤（最后一项固定为「汇总写计划并提交审批」）；计划正文写活动计划文件，不进 todo。

TDD 纪律：
- 代码任务（非文档/配置）每个任务的第一步应是写或更新测试（RED），再实现通过（GREEN）。todo 结构体现这一点：如「写 X 的测试」→「实现 X」→「重构」。
- 以下不强制：文档、配置改动、已有测试覆盖的重构、快速 typo 修复。

状态规则：
- 开工前把任务标为 in_progress；任何时刻恰好只有一个 in_progress。
- 完成立即标 completed——不要攒批。
- 重写清单时不要静默丢弃或重置已完成项。

验收面：代码任务首次 write 时用 acceptance 字段声明可观察的完成标志（形状与正反例见该字段说明）。`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'read 读当前清单；write 写新清单',
          },
          todos: {
            type: 'array',
            description: '完整 todo 清单（仅 write 用）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '任务唯一标识' },
                content: { type: 'string', description: '任务描述' },
                status: { type: 'string', enum: [...VALID_STATUSES], description: '任务状态' },
              },
              required: ['id', 'content', 'status'],
            },
          },
          acceptance: {
            type: 'array',
            description: '用户级验收面（可选，代码任务建议首次 write 就带；声明须早于验证）。'
              + '正例「按 ESC 后弹窗 isVisible() 为 False」。'
              + '反例一律拒绝：「信号连通」「函数逻辑正确」是内部属性；'
              + '「所有测试通过」「跑 test_x.py 看到 3 passed」是信号级——单测覆盖的是函数分支，不是用户按键后的行为。',
            items: {
              type: 'object',
              properties: {
                criterion: { type: 'string', description: '用户做什么动作 → 看到什么可观察结果' },
                status: { type: 'string', enum: ['pending', 'met', 'blocked'] },
                evidence: { type: 'string', description: 'met：实际做了什么、观察到什么；blocked：为何执行不了' },
              },
              required: ['criterion', 'status'],
            },
          },
        },
        required: ['action'],
      },
    },

    async execute(params) {
      const parsed = todoActionSchema.safeParse(params.input)
      if (!parsed.success) {
        return { content: `无效输入：${parsed.error.message}`, isError: true, errorKind: 'format_error' }
      }

      const data = parsed.data

      if (data.action === 'read') {
        const todos = store.read()
        if (todos.length === 0) {
          return { content: TODO_EMPTY_RESULT }
        }
        return { content: TodoStore.formatList(todos) }
      }

      // Warn (don't block) when this write resets or drops a previously
      // completed item — the signature of post-compaction memory loss. A
      // legitimate re-open is still allowed; the model just gets told so it
      // can confirm rather than silently redo finished work. (Thread 3)
      const regressions = store.detectRegressions(data.todos)
      store.recordWrite(regressions)

      store.write(data.todos)

      // U6/C1: the todo list IS the LLM's goal decomposition. Surface the
      // ordered descriptions to the loop, which seeds the PlanExecutionTrace
      // 同步到 PlanExecutionTrace：首次写入会 seed，后续写入会同步状态。
      if (params.onPlanSteps && data.todos.length > 0) {
        params.onPlanSteps(data.todos.map(t => ({ id: t.id, content: t.content, status: t.status })))
      }

      // 用户级验收面：声明与核销共用这一个字段。loop 侧写 successCriteria 并
      // satisfy/block acceptance 义务——这是该义务唯一的核销入口。
      if (params.onAcceptance && data.acceptance && data.acceptance.length > 0) {
        params.onAcceptance(data.acceptance)
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
        content = `⚠️ ${regressions.length} 项此前已完成的任务被重置或移除：\n${warn}\n\n`
            + `若非有意为之（例如长任务后凭记忆重建清单），请重新标为 completed。不要重做已完成的工作。\n\n${content}`
      }

      if (data.acceptance && data.acceptance.length > 0) {
        const met = data.acceptance.filter(a => a.status === 'met').length
        const blocked = data.acceptance.filter(a => a.status === 'blocked').length
        const pending = data.acceptance.length - met - blocked
        content += `\n\n验收面 ${met}/${data.acceptance.length} 达标`
          + (pending > 0 ? `，${pending} 项待执行` : '')
          + (blocked > 0 ? `，${blocked} 项受阻（交付时须披露）` : '')
          + '。'
      }

      // P1-1: 续用回执——提醒模型继续用 todo 跟踪进度
      content += '\n\n继续用 todo 跟踪进度——完成即标 completed，保持恰好一个 in_progress。'

      return { content }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const TODO_TOOL: Tool = createTodoTool()
