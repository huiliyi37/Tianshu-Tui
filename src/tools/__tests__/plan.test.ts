import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_TOOL } from '../plan.js'
import { parsePlanOptions } from '../../plan/plan-store.js'

describe('plan tool submit', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-plan-submit-'))
    // Fact-anchor gate verifies referenced paths against the working tree —
    // materialize the files the fixtures cite so honest plans stay accepted.
    mkdirSync(join(dir, 'src/agent'), { recursive: true })
    writeFileSync(join(dir, 'src/foo.ts'), 'export const foo = 1\n', 'utf-8')
    writeFileSync(
      join(dir, 'src/agent/loop.ts'),
      Array.from({ length: 150 }, (_, i) => `// line ${i + 1}`).join('\n'),
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function execute(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return PLAN_TOOL.execute({
      cwd: dir,
      input,
      toolUseId: 'test-tool-use',
      ...extra,
    } as any)
  }

  it('rejects a plan with too many placeholders', async () => {
    const plan = [
      '## 根因分析',
      'TODO',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '1. 修改 `src/foo.ts` — 待补充',
      '2. 修改 `src/bar.ts` — TBD',
      '## 验证',
      'FIXME',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Placeholder Plan', plan })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('占位符'))
    assert.ok(!result.content.includes('Plan submitted'))
  })

  it('rejects a plan with empty sections', async () => {
    const plan = [
      '## 根因分析',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '## 验证',
      '',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Empty Section Plan', plan })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('空章节'))
  })

  it('rejects a plan without a mermaid diagram on first submission', async () => {
    const result = await execute({
      action: 'submit',
      title: 'No Diagram Plan',
      plan: '## 根因分析\n具体原因说明。\n\n## 实现方案\n修改 src/foo.ts。',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('no Mermaid diagram'))
  })

  it('accepts a concrete plan with a mermaid diagram', async () => {
    const plan = [
      '## 根因分析',
      '循环条件在边界情况下未重置。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A[输入] --> B{边界?}',
      '    B -->|是| C[重置计数器]',
      '    B -->|否| D[继续]',
      '```',
      '',
      '修改 `src/agent/loop.ts:120`：',
      '```ts',
      'if (boundary) counter = 0',
      '```',
      '',
      '## 验证',
      '1. 新增单元测试覆盖边界条件。',
      '2. 运行 `npm test`。',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Concrete Plan', plan })
    assert.ok(!result.isError)
    assert.ok(result.content.includes('Plan submitted'))

    const written = readFileSync(join(dir, '.rivet/plans/concrete-plan.md'), 'utf-8')
    assert.ok(written.includes('# Concrete Plan'))
    assert.ok(written.includes('flowchart TD'))
    assert.ok(written.includes('src/agent/loop.ts:120'))
  })

  it('submits from active plan file when plan field is omitted', async () => {
    const draftPath = '.rivet/plans/draft-test.md'
    const abs = join(dir, draftPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, [
      '# Draft Title',
      '',
      '## 根因分析',
      '边界条件未重置。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '',
      '修改 `src/foo.ts`。',
    ].join('\n'), 'utf-8')

    const result = await execute(
      { action: 'submit', title: 'From Draft' },
      { activePlanFilePath: draftPath },
    )
    assert.ok(!result.isError)
    assert.ok(result.content.includes('Plan submitted'))

    const written = readFileSync(join(dir, '.rivet/plans/from-draft.md'), 'utf-8')
    assert.ok(written.includes('# Draft Title'))
    assert.ok(written.includes('flowchart TD'))
  })

  // 2026-07-03 缺陷复盘: 驳回后模型修订同一文件再重提交(省略 plan 字段),
  // 残留的 Status: REJECTED 标记曾让新提交被 parsePlanStatus 误判为 rejected,
  // 从待批准列表消失。submit 必须剥离历史状态标记。
  it('strips stale status markers when resubmitting a rejected plan file', async () => {
    const draftPath = '.rivet/plans/revise-me.md'
    const abs = join(dir, draftPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, [
      '> **Status: REJECTED** — 2026-07-03T00:00:00.000Z',
      '',
      '# Revised Plan',
      '',
      '## 根因分析',
      '边界条件未重置。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '',
      '修改 `src/foo.ts`（已按反馈调整）。',
    ].join('\n'), 'utf-8')

    const result = await execute(
      { action: 'submit', title: 'Revised Plan' },
      { activePlanFilePath: draftPath },
    )
    assert.ok(!result.isError, result.content)

    const written = readFileSync(join(dir, '.rivet/plans/revised-plan.md'), 'utf-8')
    assert.ok(!written.includes('Status: REJECTED'), 'stale rejection marker must not survive resubmission')
    assert.ok(written.trimStart().startsWith('# Revised Plan'))
  })

  it('persists options in plan frontmatter', async () => {
    const plan = [
      '## 根因分析',
      '需要缓存层。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
    ].join('\n')

    const result = await execute({
      action: 'submit',
      title: 'Options Plan',
      plan,
      options: [
        { label: 'Redis cache (Recommended)', description: 'Fast, eventual consistency' },
        { label: 'In-memory LRU', description: 'Simple, single process only' },
      ],
    })
    assert.ok(!result.isError)

    const written = readFileSync(join(dir, '.rivet/plans/options-plan.md'), 'utf-8')
    const options = parsePlanOptions(written)
    assert.equal(options?.length, 2)
    assert.equal(options?.[0]?.label, 'Redis cache (Recommended)')
  })

  // 2026-07-04 缺陷复盘: 一份计划提出"新增 Ink 组件"于一个不存在的目录——scout 读了
  // 过时文档、规划者未复核、submit 门禁只查形式。事实锚点门禁在提交边界拦下这类漂移。
  it('soft-blocks first submit with drifted anchors, passes resubmission with residual note', async () => {
    const plan = [
      '## 根因分析',
      '权限入口分散。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '',
      '- [ ] 新增 `src/tui/components/selector.tsx` — 选择器组件',
      '修改 `src/ghost.ts` 的导出。',
    ].join('\n')

    const first = await execute({ action: 'submit', title: 'Anchor Drift Plan', plan })
    assert.equal(first.isError, true)
    assert.ok(first.content.includes('事实锚点'), first.content)
    assert.ok(first.content.includes('src/tui/components/selector.tsx'), 'missing-parent-dir drift listed')
    assert.ok(first.content.includes('src/ghost.ts'), 'missing-file drift listed')
    assert.ok(!existsSync(join(dir, '.rivet/plans/anchor-drift-plan.md')), 'plan must not be persisted on first offense')

    const second = await execute({ action: 'submit', title: 'Anchor Drift Plan', plan })
    assert.ok(!second.isError, second.content)
    assert.ok(second.content.includes('Plan submitted'))
    assert.ok(second.content.includes('锚点残留提示'), 'residual drift note kept on pass-through')
  })

  it('does not flag anchors that match the working tree', async () => {
    const plan = [
      '## 根因分析',
      '边界未重置。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '',
      '修改 `src/agent/loop.ts:120` 与 `src/foo.ts`。',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Clean Anchor Plan', plan })
    assert.ok(!result.isError, result.content)
    assert.ok(!result.content.includes('锚点残留提示'))
  })

  it('rejects reserved option labels', async () => {
    const plan = [
      '## 根因分析',
      'x',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
    ].join('\n')

    const result = await execute({
      action: 'submit',
      title: 'Bad Options',
      plan,
      options: [{ label: 'Approve', description: 'bad' }],
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('reserved'))
  })
})
