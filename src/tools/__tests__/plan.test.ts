import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_TOOL, checkPlanScale, PLAN_SCALE_TASK_THRESHOLD } from '../plan.js'
import { parsePlanOptions, parsePlanModel } from '../../plan/plan-store.js'

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

  // 瑶光反证门禁（one-shot 软拦）要求计划含"反证/复现"章节——需要通过该
  // 门禁的 fixture 统一附加这段，让它们到达各自要测的后续闸门/成功路径。
  const FALSIFICATION = [
    '',
    '## 瑶光反证',
    '关键断言：边界分支位于 `src/foo.ts`（设计定稿后回读确认）。',
    '待验证假设：无。',
  ].join('\n')

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
    ].join('\n') + FALSIFICATION

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
    ].join('\n') + FALSIFICATION, 'utf-8')

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

  // 2026-07-04 缺陷复盘: plan-mode 工作草稿（draft-<ts>.md）提交成功后残留，
  // 曾以 "Untitled Plan"/重复 chip 的形态污染桌面计划列表。提交即回收。
  it('deletes the draft-shaped source file after a successful submit', async () => {
    const draftPath = '.rivet/plans/draft-1751600000000.md'
    const abs = join(dir, draftPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, [
      '# Recycled Draft',
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
    ].join('\n') + FALSIFICATION, 'utf-8')

    const result = await execute(
      { action: 'submit', title: 'Recycled Draft' },
      { activePlanFilePath: draftPath },
    )
    assert.ok(!result.isError, result.content)
    assert.ok(existsSync(join(dir, '.rivet/plans/recycled-draft.md')), 'canonical plan file written')
    assert.ok(!existsSync(abs), 'source draft recycled after successful submit')
  })

  it('leaves the draft untouched when plan content is passed directly', async () => {
    const draftPath = '.rivet/plans/draft-1751600000001.md'
    const abs = join(dir, draftPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '# Unrelated Draft\n\nstill being written\n', 'utf-8')

    const plan = [
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
    ].join('\n') + FALSIFICATION

    const result = await execute(
      { action: 'submit', title: 'Inline Plan Content', plan },
      { activePlanFilePath: draftPath },
    )
    assert.ok(!result.isError, result.content)
    assert.ok(existsSync(abs), 'draft not consumed by an inline-content submit')
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
    ].join('\n') + FALSIFICATION, 'utf-8')

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
    ].join('\n') + FALSIFICATION

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
    ].join('\n') + FALSIFICATION

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
    ].join('\n') + FALSIFICATION

    const result = await execute({ action: 'submit', title: 'Clean Anchor Plan', plan })
    assert.ok(!result.isError, result.content)
    assert.ok(!result.content.includes('锚点残留提示'))
  })

  // ── 层1b: 产出模型留痕 ──
  it('stamps the producing model into the plan and warns on cheap tier', async () => {
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
      '修改 `src/foo.ts`。',
    ].join('\n') + FALSIFICATION

    const result = await execute(
      { action: 'submit', title: 'Provenance Plan', plan },
      { sessionModel: 'gemini-2.5-flash' },
    )
    assert.ok(!result.isError, result.content)
    assert.ok(result.content.includes('低阶模型'), 'cheap-tier warning surfaced in tool output')

    const written = readFileSync(join(dir, '.rivet/plans/provenance-plan.md'), 'utf-8')
    const provenance = parsePlanModel(written)
    assert.equal(provenance?.model, 'gemini-2.5-flash')
    assert.equal(provenance?.tier, 'cheap')
  })

  // ── 层2: 规模门禁 — 大计划必须分波 ──
  function oversizedPlanBody(): string {
    const tasks = Array.from(
      { length: PLAN_SCALE_TASK_THRESHOLD + 1 },
      (_, i) => `- [ ] 任务 ${i + 1} — 修改 \`src/foo.ts\``,
    )
    return [
      '## 根因分析',
      '范围很大。',
      '',
      '## 实现方案',
      '```mermaid',
      'flowchart TD',
      '    A --> B',
      '```',
      '',
      ...tasks,
    ].join('\n') + FALSIFICATION
  }

  it('soft-blocks an oversized plan without wave structure, passes resubmission with note', async () => {
    const plan = oversizedPlanBody()

    const first = await execute({ action: 'submit', title: 'Oversized Plan', plan })
    assert.equal(first.isError, true)
    assert.ok(first.content.includes('规模超阈值'), first.content)
    assert.ok(first.content.includes('分波'), 'block message explains the wave requirement')
    assert.ok(!existsSync(join(dir, '.rivet/plans/oversized-plan.md')), 'not persisted on first offense')

    const second = await execute({ action: 'submit', title: 'Oversized Plan', plan })
    assert.ok(!second.isError, second.content)
    assert.ok(second.content.includes('规模留痕'), 'residual scale note kept on pass-through')
  })

  it('accepts an oversized plan that declares waves with per-wave verification', async () => {
    const plan = [
      oversizedPlanBody(),
      '',
      '## 分波执行',
      '### Wave 1',
      '任务 1-5。每波验证命令：`npx tsc --noEmit`',
      '### Wave 2',
      '任务 6-9。每波验证命令：`npm test`',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Waved Plan', plan })
    assert.ok(!result.isError, result.content)
    assert.ok(!result.content.includes('规模留痕'), 'wave-structured plan passes without scale note')
  })

  // ── 瑶光反证门禁 — 计划期复现 ──
  it('soft-blocks first submit without a 反证/复现 section, passes resubmission', async () => {
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
      '修改 `src/foo.ts`。',
    ].join('\n')

    const first = await execute({ action: 'submit', title: 'No Falsification Plan', plan })
    assert.equal(first.isError, true)
    assert.ok(first.content.includes('瑶光反证'), first.content)
    assert.ok(first.content.includes('复现'), 'block message explains plan-time reproduction')
    assert.ok(first.content.includes('adversarial_verifier'), 'block message names the reproduction delegate')
    assert.ok(!existsSync(join(dir, '.rivet/plans/no-falsification-plan.md')), 'not persisted on first offense')

    const second = await execute({ action: 'submit', title: 'No Falsification Plan', plan })
    assert.ok(!second.isError, second.content)
    assert.ok(second.content.includes('Plan submitted'))
  })

  it('accepts a plan carrying a 复现 heading without the soft block', async () => {
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
      '修改 `src/foo.ts`。',
      '',
      '## 原缺陷复现',
      '`npm test -- boundary` 输出 `FAIL: counter not reset`（RED 证据）。',
    ].join('\n')

    const result = await execute({ action: 'submit', title: 'Reproduced Plan', plan })
    assert.ok(!result.isError, result.content)
    assert.ok(result.content.includes('Plan submitted'))
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

describe('plan tool enter_mode', () => {
  function execute(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return PLAN_TOOL.execute({
      cwd: process.cwd(),
      input,
      toolUseId: 'test-enter-mode',
      ...extra,
    } as any)
  }

  it('fails closed when the enterPlanMode ref is absent (worker context)', async () => {
    const result = await execute({ action: 'enter_mode' })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('not available'))
  })

  it('enters plan mode via the pre-bound ref and reports the draft path', async () => {
    let called = 0
    const result = await execute({ action: 'enter_mode' }, {
      enterPlanMode: () => {
        called++
        return { activePlanFilePath: '.rivet/plans/draft-1.md', alreadyPlanning: false }
      },
    })
    assert.equal(called, 1)
    assert.ok(!result.isError, result.content)
    assert.ok(result.content.includes('Entered plan mode'))
    assert.ok(result.content.includes('.rivet/plans/draft-1.md'))
    assert.ok(result.content.includes('delegate_batch'), 'nudges parallel scout research')
  })

  it('is idempotent when already planning', async () => {
    const result = await execute({ action: 'enter_mode' }, {
      enterPlanMode: () => ({ activePlanFilePath: '.rivet/plans/draft-2.md', alreadyPlanning: true }),
    })
    assert.ok(!result.isError)
    assert.ok(result.content.includes('Already in plan mode'))
    assert.ok(result.content.includes('.rivet/plans/draft-2.md'))
  })

  it('unknown action error mentions enter_mode', async () => {
    const result = await execute({ action: 'bogus' })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('enter_mode'))
  })
})

describe('checkPlanScale (纯函数)', () => {
  it('counts checkbox tasks and file anchors', () => {
    const content = [
      '- [ ] one `src/a/b.ts`',
      '- [x] two',
      '* [ ] three',
      '普通行不算',
    ].join('\n')
    const scale = checkPlanScale(content)
    assert.equal(scale.taskCount, 3)
    assert.equal(scale.fileCount, 1)
    assert.equal(scale.oversized, false)
  })

  it('flags oversized by file count alone', () => {
    const files = Array.from({ length: 16 }, (_, i) => `修改 \`src/mod${i}/file${i}.ts\``).join('\n')
    const scale = checkPlanScale(files)
    assert.ok(scale.fileCount > 15)
    assert.equal(scale.oversized, true)
  })

  it('detects wave structure only when both wave headings and verification are declared', () => {
    const noVerify = '### Wave 1\n做事\n### Wave 2\n做别的'
    assert.equal(checkPlanScale(noVerify).hasWaveStructure, false)
    const withVerify = '### Wave 1\n做事。每波验证命令：`npx tsc --noEmit`\n### Wave 2\n做别的'
    assert.equal(checkPlanScale(withVerify).hasWaveStructure, true)
    const chinese = '## 第一波\n做事\n\n每波验证：npm test'
    assert.equal(checkPlanScale(chinese).hasWaveStructure, true)
  })
})
