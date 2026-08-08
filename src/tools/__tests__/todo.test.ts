import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { TODO_TOOL, createTodoTool, getTodos, setTodos } from '../todo.js'
import { TodoStore } from '../todo-store.js'

describe('TODO_TOOL', () => {
  beforeEach(() => {
    setTodos([])
  })

  it('has correct definition name', () => {
    assert.equal(TODO_TOOL.definition.name, 'todo')
  })

  it('writes todos and returns formatted output', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [
          { id: '1', content: 'Read main.tsx', status: 'completed' },
          { id: '2', content: 'Fix bug in loop', status: 'in_progress' },
          { id: '3', content: 'Add tests', status: 'pending' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Read main.tsx'))
    assert.ok(result.content.includes('Fix bug in loop'))
  })

  it('reads current todos', async () => {
    await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [{ id: '1', content: 'Task A', status: 'pending' }],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })

    const result = await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_2',
      cwd: '/repo',
    })
    assert.ok(result.content.includes('Task A'))
  })

  it('returns message when no todos', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.ok(result.content.includes('暂无待办'))
  })

  it('rejects unknown action', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'delete' },
      toolUseId: 'tu_4',
      cwd: '/repo',
    })
    assert.equal(result.isError, true)
  })

  it('does not require approval', () => {
    assert.equal(TODO_TOOL.requiresApproval({ input: { action: 'write' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('is concurrency safe', () => {
    assert.equal(TODO_TOOL.isConcurrencySafe(), true)
  })

  it('warns when a write resets a previously-completed item', async () => {
    setTodos([
      { id: '1', content: 'Ship feature', status: 'completed' },
      { id: '2', content: 'Add tests', status: 'in_progress' },
    ])
    const result = await TODO_TOOL.execute({
      input: { action: 'write', todos: [
        { id: '1', content: 'Ship feature', status: 'pending' },
        { id: '2', content: 'Add tests', status: 'in_progress' },
      ] },
      toolUseId: 't', cwd: '/',
    })
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('⚠️'), 'should warn on regression')
    assert.ok(result.content.includes('Ship feature'))
    assert.ok(result.content.includes('不要重做'))
  })
})

describe('TodoStore', () => {
  it('isolates state between stores', () => {
    const store1 = new TodoStore()
    const store2 = new TodoStore()

    store1.write([{ id: '1', content: 'Task A', status: 'pending' }])
    store2.write([{ id: '2', content: 'Task B', status: 'in_progress' }])

    assert.equal(store1.read().length, 1)
    assert.equal(store1.read()[0]!.content, 'Task A')
    assert.equal(store2.read().length, 1)
    assert.equal(store2.read()[0]!.content, 'Task B')
  })

  it('returns empty array for new store', () => {
    const store = new TodoStore()
    assert.deepEqual(store.read(), [])
  })

  it('write replaces entire list', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Old', status: 'completed' }])
    store.write([{ id: '2', content: 'New', status: 'pending' }])
    assert.equal(store.read().length, 1)
    assert.equal(store.read()[0]!.content, 'New')
  })

  it('detectRegressions v2: completed→pending 命中回归，删除完成项只计退休', () => {
    const store = new TodoStore()
    store.write([
      { id: '1', content: 'Build parser', status: 'completed' },
      { id: '2', content: 'Wire CLI', status: 'completed' },
      { id: '3', content: 'Write docs', status: 'in_progress' },
    ])
    // Model rebuilds from lossy memory: id 1 reset to pending, id 2 dropped.
    const detection = store.detectRegressions([
      { id: '1', content: 'Build parser', status: 'pending' },
      { id: '3', content: 'Write docs', status: 'in_progress' },
    ])
    assert.deepEqual(detection.retired, ['Wire CLI'], '删除完成项 = 主动退休，不进回归')
    assert.equal(detection.regressed.length, 1, '只有真实重开算回归')
    assert.ok(detection.regressed[0]!.includes('Build parser'))
    assert.ok(detection.regressed[0]!.includes('pending'))
  })

  it('detectRegressions returns empty when completed items stay completed', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Done thing', status: 'completed' }])
    const detection = store.detectRegressions([
      { id: '1', content: 'Done thing', status: 'completed' },
      { id: '2', content: 'New thing', status: 'pending' },
    ])
    assert.deepEqual(detection, { regressed: [], retired: [] })
  })

  it('v2 场景 1：新波次替换零回归（主动替换清单不警告）', () => {
    const store = new TodoStore()
    store.write([
      { id: '1', content: 'Fix auth', status: 'completed' },
      { id: '2', content: 'Fix cache', status: 'completed' },
    ])
    // 切换到新波次：整份清单替换为不相关项
    const detection = store.detectRegressions([
      { id: 'a', content: 'Implement search', status: 'pending' },
      { id: 'b', content: 'Add telemetry', status: 'pending' },
    ])
    assert.deepEqual(detection.regressed, [], '波次替换不得警告')
    assert.deepEqual(detection.retired.sort(), ['Fix auth', 'Fix cache'])
    store.recordWrite(detection)
    assert.equal(store.getRegressionStats().retiredCompletedItems, 2)
  })

  it('v2 场景 2：直接 completed→pending 命中回归', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Build parser', status: 'completed' }])
    const detection = store.detectRegressions([
      { id: '1', content: 'Build parser', status: 'pending' },
    ])
    assert.equal(detection.regressed.length, 1)
    assert.ok(detection.regressed[0]!.includes('Build parser'))
  })

  it('v2 场景 3：删除后换 ID 同内容重现 → 命中回归（跨 write）', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Fix auth', status: 'completed' }])
    // 第一波：删除完成项（退休）——tombstone 写入发生在 write 里
    store.write([])
    // 第二波：换 ID 但同内容重现为 pending——真实重开
    const detection = store.detectRegressions([
      { id: '9', content: 'Fix auth', status: 'pending' },
    ])
    assert.equal(detection.regressed.length, 1, '同内容换 ID 重现必须命中')
    assert.ok(detection.regressed[0]!.includes('退休后重新出现'))
    // 消费：write 命中指纹 → tombstone 清除，同一重开只警告一次
    store.write([{ id: '9', content: 'Fix auth', status: 'pending' }])
    const second = store.detectRegressions([
      { id: '9', content: 'Fix auth', status: 'pending' },
    ])
    assert.deepEqual(second.regressed, [], 'tombstone 已被消费，不重复警告')
  })

  it('v2 场景 4：正常 completed 清理只计退休', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Done', status: 'completed' }])
    const detection = store.detectRegressions([])
    assert.deepEqual(detection.regressed, [])
    assert.deepEqual(detection.retired, ['Done'])
    store.recordWrite(detection)
    assert.equal(store.getRegressionStats().retiredCompletedItems, 1)
  })

  it('v2：退休后以 completed 重现不算回归（正常重做完）', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Fix auth', status: 'completed' }])
    store.write([]) // 退休
    // 模型重做完成：同一内容以 completed 重现
    store.write([{ id: '1', content: 'Fix auth', status: 'completed' }])
    const detection = store.detectRegressions([{ id: '1', content: 'Fix auth', status: 'completed' }])
    assert.deepEqual(detection, { regressed: [], retired: [] }, 'completed 重现清除 tombstone，无任何回归')
  })
})

// The detector's trigger used to render one warning and vanish. These counters are
// the denominator+numerator that make a cross-session "todo 退回率" comparable.
describe('TodoStore regression counters', () => {
  it('starts at zero and reports writes as the denominator', () => {
    const store = new TodoStore()
    assert.deepEqual(store.getRegressionStats(), {
      writes: 0, regressedWrites: 0, regressedItems: 0,
      detectorVersion: 2, retiredCompletedItems: 0,
    })
    store.recordWrite({ regressed: [], retired: [] })
    store.recordWrite({ regressed: [], retired: [] })
    assert.deepEqual(store.getRegressionStats(), {
      writes: 2, regressedWrites: 0, regressedItems: 0,
      detectorVersion: 2, retiredCompletedItems: 0,
    })
  })

  it('counts a write once but every regressed item within it', () => {
    const store = new TodoStore()
    store.recordWrite({ regressed: ['a（completed → pending）', 'b（退休后重新出现为 pending）'], retired: [] })
    assert.deepEqual(store.getRegressionStats(), {
      writes: 1, regressedWrites: 1, regressedItems: 2,
      detectorVersion: 2, retiredCompletedItems: 0,
    })
  })

  it('retired items accumulate separately from regressions', () => {
    const store = new TodoStore()
    store.recordWrite({ regressed: [], retired: ['a', 'b'] })
    store.recordWrite({ regressed: ['c（completed → pending）'], retired: ['d'] })
    const stats = store.getRegressionStats()
    assert.equal(stats.writes, 2)
    assert.equal(stats.regressedWrites, 1)
    assert.equal(stats.regressedItems, 1)
    assert.equal(stats.retiredCompletedItems, 3, '退休与回归分开累计')
  })

  it('the tool path feeds the counters on every write', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store)
    const call = (status: 'completed' | 'pending') => tool.execute({
      input: { action: 'write', todos: [{ id: '1', content: 'Ship it', status }] },
      toolUseId: `tu_${status}`,
      cwd: '/repo',
    })
    await call('completed')
    await call('pending')

    const stats = store.getRegressionStats()
    assert.equal(stats.writes, 2, 'both writes counted')
    assert.equal(stats.regressedWrites, 1, 'only the second write regressed')
    assert.equal(stats.regressedItems, 1)
  })

  it('getRegressionStats hands back a copy — callers cannot mutate the tally', () => {
    const store = new TodoStore()
    store.recordWrite({ regressed: ['x'], retired: [] })
    const snapshot = store.getRegressionStats()
    snapshot.writes = 999
    assert.equal(store.getRegressionStats().writes, 1)
  })
})

describe('TODO_TOOL scope gate', () => {
  beforeEach(() => {
    setTodos([])
  })

  const write = (todos: Array<{ id: string; content: string; status: string }>) =>
    TODO_TOOL.execute({ input: { action: 'write', todos }, toolUseId: 'tu', cwd: '/repo' })

  it('stays quiet for a small flat list', async () => {
    const r = await write([
      { id: '1', content: 'fix a', status: 'pending' },
      { id: '2', content: 'fix b', status: 'pending' },
    ])
    assert.ok(!r.content.includes('⚠️'))
    assert.ok(!r.content.includes('⛔'))
  })

  it('surfaces a pause-and-confirm notice when scope is high', async () => {
    const todos = Array.from({ length: 11 }, (_, i) => ({
      id: `T${i + 1}`, content: `task ${i + 1}`, status: 'pending',
    }))
    const r = await write(todos)
    assert.ok(r.content.includes('⚠️'), 'high-risk notice present')
    assert.ok(r.content.includes('确认范围'))
  })

  it('lists blocked items but never errors', async () => {
    const r = await write([
      { id: 'T1', content: '基础模块', status: 'pending' },
      { id: 'T2', content: '基于 T1 的扩展', status: 'pending' },
    ])
    assert.equal(r.isError, undefined)
    assert.ok(r.content.includes('⛔'))
    assert.ok(r.content.includes('仍保留在列表中'))
  })

  it('does not false-positive on bare-number quantities', async () => {
    const r = await write([
      { id: '1', content: '修复登录 bug', status: 'pending' },
      { id: '2', content: '还剩 1 个测试要写', status: 'pending' },
    ])
    // "还剩 1 个" must not be read as "depends on todo 1" → no blocked marker
    assert.ok(!r.content.includes('⛔'))
  })

  it('scope notice composes after a regression warning', async () => {
    setTodos([{ id: 'T1', content: '已完成项', status: 'completed' }])
    // re-open T1 (regression) + push the list over the high-risk threshold
    const todos = [
      { id: 'T1', content: '已完成项', status: 'pending' },
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `N${i + 1}`, content: `task ${i + 1}`, status: 'pending',
      })),
    ]
    const r = await write(todos)
    const regressionIdx = r.content.indexOf('此前已完成')
    const noticeIdx = r.content.indexOf('⚠️ 范围风险')
    assert.ok(regressionIdx >= 0, 'regression warning present')
    assert.ok(noticeIdx >= 0, 'scope notice present')
    assert.ok(regressionIdx < noticeIdx, 'regression warning leads, scope notice follows')
  })
})

// ─── U6/C1: onPlanSteps callback (todo → PlanExecutionTrace seed) ──

describe('TODO_TOOL onPlanSteps (U6/C1)', () => {
  beforeEach(() => setTodos([]))

  it('write invokes onPlanSteps with the ordered step inputs', async () => {
    const captured: Array<{ id?: string; content: string; status?: string }>[] = []
    await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [
          { id: '1', content: '读取 loop.ts 理解现状', status: 'pending' },
          { id: '2', content: '修改 detectDeviation', status: 'pending' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
      onPlanSteps: d => captured.push(d),
    })
    assert.equal(captured.length, 1)
    assert.deepEqual(
      captured[0]!.map(s => s.content),
      ['读取 loop.ts 理解现状', '修改 detectDeviation'],
    )
  })

  it('read does not invoke onPlanSteps', async () => {
    let calls = 0
    await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_1',
      cwd: '/repo',
      onPlanSteps: () => { calls++ },
    })
    assert.equal(calls, 0)
  })

  it('empty todo list does not invoke onPlanSteps', async () => {
    let calls = 0
    await TODO_TOOL.execute({
      input: { action: 'write', todos: [] },
      toolUseId: 'tu_1',
      cwd: '/repo',
      onPlanSteps: () => { calls++ },
    })
    assert.equal(calls, 0)
  })

  it('write without onPlanSteps does not throw (no-op)', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'write', todos: [{ id: '1', content: 'x', status: 'pending' }] },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
  })
})

// ─── 交付前行为验收闸门：acceptance 字段是 acceptance 义务唯一的核销入口 ──

describe('TODO_TOOL acceptance 字段', () => {
  beforeEach(() => setTodos([]))

  const oneTodo = [{ id: '1', content: '改弹窗取消逻辑', status: 'pending' }]

  it('声明经 onAcceptance 原样流出（criterion + status + evidence）', async () => {
    const captured: unknown[][] = []
    await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: oneTodo,
        acceptance: [
          { criterion: '按 ESC 后弹窗 isVisible() 为 False', status: 'pending' },
          { criterion: '流程状态为 cancelled', status: 'met', evidence: 'state == cancelled' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
      onAcceptance: items => captured.push(items),
    })
    assert.equal(captured.length, 1)
    assert.deepEqual(captured[0], [
      { criterion: '按 ESC 后弹窗 isVisible() 为 False', status: 'pending' },
      { criterion: '流程状态为 cancelled', status: 'met', evidence: 'state == cancelled' },
    ])
  })

  it('不带 acceptance 时不触发回调（既有调用方零行为变化）', async () => {
    let calls = 0
    await TODO_TOOL.execute({
      input: { action: 'write', todos: oneTodo },
      toolUseId: 'tu_1',
      cwd: '/repo',
      onAcceptance: () => { calls++ },
    })
    assert.equal(calls, 0)
  })

  it('未接 onAcceptance 时不抛（worker/非任务上下文 no-op）', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: oneTodo,
        acceptance: [{ criterion: '按 ESC 后弹窗消失', status: 'pending' }],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
  })

  it('回执里报达标进度，受阻项点名要披露', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: oneTodo,
        acceptance: [
          { criterion: 'a', status: 'met', evidence: '跑过了' },
          { criterion: 'b', status: 'pending' },
          { criterion: 'c', status: 'blocked', evidence: '无 GUI 环境' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.match(result.content, /验收面 1\/3 达标/)
    assert.match(result.content, /1 项待执行/)
    assert.match(result.content, /1 项受阻/)
  })

  it('非法 status 被 schema 拒绝，不静默吞掉', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: oneTodo,
        acceptance: [{ criterion: 'a', status: 'done' }],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, true)
  })

  it('schema 里写死了信号级反例——防止验收面退化成 delivery 的替身', () => {
    const schema = JSON.stringify(TODO_TOOL.definition.input_schema)
    assert.match(schema, /passed/)
    assert.match(schema, /所有测试通过/)
    assert.match(TODO_TOOL.definition.description, /验收面/)
  })
})

describe('TODO_TOOL description', () => {
  // ── P1-1: description + continuation reminder ─────────────────

  it('description includes when-to-use and when-not-to-use guidance', () => {
    const desc = TODO_TOOL.definition.description
    // when-to-use triggers
    assert.ok(desc.includes('3 个以上不同步骤') || desc.includes('多文件'))
    // when-not-to-use: explicit negative example
    assert.ok(desc.includes('单步琐碎') || desc.includes('一次性小编辑'))
    // proactive capture
    assert.ok(desc.includes('收到新指令后立即建') || desc.includes('先落成 todo'))
    // plan-mode 调研约定
    assert.ok(desc.includes('汇总写计划并提交审批'), 'plan-mode todo convention documented')
  })

  it('write success returns continuation reminder', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [
          { id: '1', content: 'Read main.tsx', status: 'completed' },
          { id: '2', content: 'Fix bug in loop', status: 'in_progress' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
    // RED: currently no continuation reminder
    assert.ok(result.content.includes('继续用 todo 跟踪进度') || result.content.includes('track progress with todo'))
  })
})

