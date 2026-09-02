/**
 * 契约传导（T5-T9）：段落级契约不再丢失。
 * - T9：extractContractBlocks 提取「接口契约」段落 → 注入任务 objective
 * - T7：withTaskConstraints 计划级条目独立预算（不参与 12 条限制、不截断）
 * - T8：constraintsFromUnifiedPlan 消费 assumptions → assumption 指纹
 * - T5：workOrderSchema 接受 planRef
 * 全部用真实函数（不 mock 中间层）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractContractBlocks, parseChecklistSections } from '../../tools/plan-task.js'
import { constraintsFromUnifiedPlan, extractPlanConstraints, PLAN_CONSTRAINT_PREFIX } from '../plan-constraints.js'
import { createReadOnlyWorkOrder, createWriteWorkOrder } from '../work-order.js'
import { deserializeUnifiedPlan, serializeUnifiedPlan, type UnifiedPlan } from '../unified-plan.js'

const ZEN_LIKE_PLAN = `# 测试计划

## 需求提炼

用户原话（逐字）：

> "禅模式是为了让主控专注到任务目标"

## 方案设计

### 接口契约（T1 产物形状——全部任务依赖此签名，执行 worker 不得自行变更）

\`\`\`ts
export type ZenPhase = 'zen' | 'full'
export function resolveZenConfig(raw: unknown): ResolvedZenConfig
\`\`\`

要点：onToolRequest 恒放行；timeout 按 turn 计。

### Wave 1 —— 核心机制闭环

- [ ] T1 新建 src/agent/zen-mode.ts：ZenPhase/ZenConfig
- [ ] T2 测试

### Wave 2 —— prompt 收敛

- [ ] T7 volatile.ts zenLean

## 瑶光反证（关键断言与证据状态）

| 断言 | 状态 |
|------|------|
| updateTools 运行期可换定义 | ✅ 静态已证 |
`

describe('T9 — 段落级契约提取（extractContractBlocks）', () => {
  it('提取「接口契约」段落全文（含代码块与要点）', () => {
    const blocks = extractContractBlocks(ZEN_LIKE_PLAN)
    assert.equal(blocks.length, 2, '接口契约 + 瑶光反证各一块')
    const contract = blocks[0]!
    assert.ok(contract.includes('接口契约'), '必须带契约标题')
    assert.ok(contract.includes('resolveZenConfig'), '必须含代码块内容')
    assert.ok(contract.includes('onToolRequest 恒放行'), '必须含要点正文')
  })

  it('提取「瑶光反证」段落（带语义标记的第二类契约）', () => {
    const blocks = extractContractBlocks(ZEN_LIKE_PLAN)
    const evidence = blocks[1]!
    assert.ok(evidence.includes('瑶光反证'))
    assert.ok(evidence.includes('updateTools'))
  })

  it('objective 注入：parseChecklistSections + extractContractBlocks → 任务 objective 含契约', () => {
    const sections = parseChecklistSections(ZEN_LIKE_PLAN)
    assert.equal(sections.length, 2, '两个含 checklist 的 Wave 章节')
    const contractBlocks = extractContractBlocks(ZEN_LIKE_PLAN)
    // 章节标题 + checklist + 契约块都在——worker 能看到接口契约语义
    const wave1 = sections[0]!
    assert.ok(wave1.heading.includes('Wave 1'))
    assert.ok(wave1.items.length >= 1)
    assert.ok(contractBlocks.some(b => b.includes('resolveZenConfig')), '契约块必须被提取出来供 objective 注入')
  })

  it('无契约标记的计划返回空数组（行为不变）', () => {
    const plain = '# 计划\n\n## Wave 1\n\n- [ ] 任务 A\n'
    assert.deepEqual(extractContractBlocks(plain), [])
  })
})

describe('T7 — constraints 预算分级（计划级不截断不计数）', () => {
  it('计划级条目在 12+ 条任务级限制下保留且不截断', () => {
    const longPlanLevel = `${PLAN_CONSTRAINT_PREFIX}反目标] ${'x'.repeat(800)}`
    const taskLevel = Array.from({ length: 15 }, (_, i) => `任务级约束 ${i}`)
    const wo = createReadOnlyWorkOrder({
      id: 'wo_budget',
      parentTurnId: 't',
      kind: 'code_search',
      profile: 'code_scout',
      objective: '预算分级验证',
      scope: { files: [], symbols: [] },
      constraints: [...taskLevel, longPlanLevel],
      allowedTools: ['read_file'],
      disallowedTools: [],
      dedupeKey: 'k',
      dependencies: [],
      aggregationPolicy: 'all_required',
      budget: { turns: 4 },
    } as never)
    // 计划级条目全文保留（800 字符未被 400 截断）
    assert.ok(wo.constraints.includes(longPlanLevel), '计划级条目必须全文保留')
    // 任务级仍限 12 条（计划级不占任务级预算）
    const taskLevelCount = wo.constraints.filter(c => c.startsWith('任务级约束')).length
    assert.equal(taskLevelCount, 12, '任务级仍限 12 条')
    // 模板基线行仍在（追加语义不破坏）
    assert.ok(wo.constraints.some(c => c.includes('evidence-backed claims')))
  })
})

describe('T8 — UnifiedPlan assumptions 结构化载体', () => {
  it('constraintsFromUnifiedPlan 消费 assumptions → assumption 指纹（先验证再执行）', () => {
    const items = constraintsFromUnifiedPlan({
      nonGoals: ['不重构 worker 执行模型'],
      assumptions: ['晋升点一次全前缀重建的成本可接受'],
      obligations: [],
    })
    assert.ok(items.some(c => c.includes(`${PLAN_CONSTRAINT_PREFIX}待验证假设·执行期先验证] 晋升点一次全前缀重建的成本可接受`)))
    assert.ok(items.some(c => c.includes(`${PLAN_CONSTRAINT_PREFIX}反目标] 不重构 worker 执行模型`)))
  })
})

describe('T5 — workOrder planRef 字段', () => {
  it('planRef 可写入工单（optional 向后兼容）', () => {
    const wo = createReadOnlyWorkOrder({
      id: 'wo_planref',
      parentTurnId: 't',
      kind: 'code_search',
      profile: 'code_scout',
      objective: '读计划执行',
      scope: { files: [], symbols: [] },
      constraints: [],
      allowedTools: ['read_file'],
      disallowedTools: [],
      dedupeKey: 'k',
      dependencies: [],
      aggregationPolicy: 'all_required',
      budget: { turns: 4 },
      planRef: '.rivet/plans/编排可靠性三修.md',
    } as never)
    assert.equal(wo.planRef, '.rivet/plans/编排可靠性三修.md')
  })

  it('planRef 缺省时 undefined（既有工单创建点行为不变）', () => {
    const wo = createReadOnlyWorkOrder({
      id: 'wo_noref',
      parentTurnId: 't',
      kind: 'code_search',
      profile: 'code_scout',
      objective: '普通任务',
      scope: { files: [], symbols: [] },
      constraints: [],
      allowedTools: ['read_file'],
      disallowedTools: [],
      dedupeKey: 'k',
      dependencies: [],
      aggregationPolicy: 'all_required',
      budget: { turns: 4 },
    } as never)
    assert.equal(wo.planRef, undefined)
  })

  it('写工单同样携带 planRef（coordinator 写路径透传）', () => {
    const wo = createWriteWorkOrder({
      id: 'wo_wref',
      parentTurnId: 't',
      kind: 'patch_proposal',
      objective: '按计划实施分片',
      scope: { files: ['src/a.ts'], symbols: [] },
      constraints: [],
      dependencies: [],
      aggregationPolicy: 'all_required',
      budget: { maxTurns: 4 },
      planRef: '.rivet/plans/编排可靠性三修.md',
    })
    assert.equal(wo.planRef, '.rivet/plans/编排可靠性三修.md')
  })
})

describe('T8 producer — plan_task 假设结构化载体（生产端接线）', () => {
  it('markdown「待验证假设」章节 → 假设条目 → UnifiedPlan JSON 往返存活（storePlan 链路契约）', () => {
    const markdown = [
      '## 方案',
      '',
      '- [ ] 做事',
      '',
      '## 待验证假设',
      '',
      '- 晋升点一次全前缀重建的成本可接受',
      '- 外部依赖的 alpha.2 行为与 alpha.1 语义兼容',
      '',
      '## 非目标',
      '',
      '- 不重构 worker 执行模型',
    ].join('\n')
    // plan_task 接线用的同一提取函数（kind=assumption 过滤）。
    const assumptions = extractPlanConstraints(markdown)
      .filter(c => c.kind === 'assumption')
      .map(c => c.text)
    assert.deepEqual(assumptions, [
      '晋升点一次全前缀重建的成本可接受',
      '外部依赖的 alpha.2 行为与 alpha.1 语义兼容',
    ], '非目标不得混入假设（kind 过滤必须收对）')
    // 载体契约：assumptions 经 serialize → deserialize 存活（storePlan → 自动消费链）。
    const plan: UnifiedPlan = {
      version: 1,
      objective: 'x',
      tasks: [],
      source: 'plan_task',
      createdAt: Date.now(),
      assumptions,
    }
    const roundTripped = deserializeUnifiedPlan(serializeUnifiedPlan(plan))
    assert.deepEqual(roundTripped?.assumptions, assumptions)
  })
})
