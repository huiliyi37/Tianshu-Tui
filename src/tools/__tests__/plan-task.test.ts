import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractPlanPath, parseChecklistItems, createPlanTaskTool } from '../plan-task.js'
import { getTodos, setTodos } from '../todo.js'
import type { TodoItem } from '../todo-store.js'

// ── extractPlanPath ─────────────────────────────────────────────────

describe('extractPlanPath', () => {
  it('finds .rivet/knowledge path in objective', () => {
    const path = extractPlanPath('执行 .rivet/knowledge/foo.md 中的计划')
    assert.equal(path, '.rivet/knowledge/foo.md')
  })

  it('finds docs/superpowers/plans path in objective', () => {
    const path = extractPlanPath('参考 docs/superpowers/plans/my-plan.md 执行')
    assert.equal(path, 'docs/superpowers/plans/my-plan.md')
  })

  it('finds path in files array when objective has none', () => {
    const path = extractPlanPath('实现缓存预热', ['.rivet/knowledge/bar.md', 'src/foo.ts'])
    assert.equal(path, '.rivet/knowledge/bar.md')
  })

  it('returns null for plain objective without files', () => {
    assert.equal(extractPlanPath('实现缓存预热模块'), null)
  })

  it('returns null when files array has no plan paths', () => {
    assert.equal(extractPlanPath('refactor loop', ['src/agent/loop.ts', 'src/agent/loop.test.ts']), null)
  })
})

// ── parseChecklistItems ─────────────────────────────────────────────

describe('parseChecklistItems', () => {
  it('extracts unchecked items', () => {
    const md = '- [ ] add field to `src/foo.ts`\n- [x] already done\n- [ ] write test in `src/__tests__/foo.test.ts`'
    const items = parseChecklistItems(md)
    assert.equal(items.length, 2)
    assert.equal(items[0]!.text, 'add field to `src/foo.ts`')
    assert.deepEqual(items[0]!.files, ['src/foo.ts'])
    assert.equal(items[1]!.text, 'write test in `src/__tests__/foo.test.ts`')
  })

  it('skips checked items', () => {
    assert.equal(parseChecklistItems('- [x] done item').length, 0)
  })

  it('returns empty for no checklist', () => {
    assert.equal(parseChecklistItems('just text\nmore text').length, 0)
  })

  it('extracts multiple file refs from one item', () => {
    const md = '- [ ] update `src/a.ts` and test in `src/__tests__/a.test.ts`'
    const items = parseChecklistItems(md)
    assert.deepEqual(items[0]!.files, ['src/a.ts', 'src/__tests__/a.test.ts'])
  })

  it('matches non-ts file extensions (json, md, yml)', () => {
    const md = '- [ ] update `desktop/tauri.conf.json` and `docs/plan.md`'
    const items = parseChecklistItems(md)
    assert.deepEqual(items[0]!.files, ['desktop/tauri.conf.json', 'docs/plan.md'])
  })

  it('returns empty array for all-checked checklist', () => {
    const md = '- [x] add field\n- [x] write test\n- [x] run typecheck'
    assert.equal(parseChecklistItems(md).length, 0)
  })
})

// ── writeTodos injection (multi-session isolation) ──

describe('createPlanTaskTool writeTodos routing', () => {
  it('routes generated todos to the injected writeTodos, not the global defaultStore', async () => {
    setTodos([]) // 清空全局，证明 plan_task 不写全局
    const captured: TodoItem[][] = []
    const tool = createPlanTaskTool({
      getCoordinator: () => null,
      getExecutorDeps: () => ({} as any),
      writeTodos: todos => { captured.push(todos) },
    })

    const res = await tool.execute({
      input: { objective: '实现用户登录与商品列表两个模块', execute: false },
      toolUseId: 'p1',
      cwd: process.cwd(),
    } as any)

    assert.equal(res.isError ?? false, false)
    // 隔离的核心断言：全局 defaultStore 始终为空（写入只去了注入 store）。
    assert.deepEqual(getTodos(), [])
    // 若计划产出了叶子节点，则它们经 writeTodos 落到注入 store。
    if (captured.length > 0) {
      assert.ok(captured[0]!.length > 0)
    }
  })
})

// ── Integration: parse real plan file ──

describe('integration: parse real plan file', () => {
  it('parses tianshu-omp plan checklist into items with file paths', async () => {
    const { readFile } = await import('node:fs/promises')
    const content = await readFile('.rivet/knowledge/tianshu-omp-convergence-precision-backport.md', 'utf-8')
    const items = parseChecklistItems(content)
    // The updated plan has ~12+ checklist items
    assert.ok(items.length >= 8, `expected at least 8 checklist items, got ${items.length}`)
    // Verify key items are captured
    const texts = items.map(i => i.text)
    assert.ok(texts.some(t => t.includes('argsHash')), 'should capture argsHash item')
    assert.ok(texts.some(t => t.includes('oscillation')), 'should capture oscillation item')
    assert.ok(texts.some(t => t.includes('outputTokens')), 'should capture outputTokens item')
  })
})
