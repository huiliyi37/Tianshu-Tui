import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_TOOL } from '../plan.js'
import { parsePlanOptions } from '../../plan/plan-store.js'

describe('plan tool submit', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-plan-submit-'))
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
