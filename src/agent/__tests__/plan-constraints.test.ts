import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractPlanConstraints, renderPlanConstraints, resolvePlanConstraints, type PlanConstraint } from '../plan-constraints.js'
import { withPlanConstraints } from '../coordinator.js'

/** D5 计划「## 反目标」真实片段。 */
const D5_MARKDOWN = `# D5 编排入口归层

## 反目标

- **不把 galaxy / starflow / scout 改成 skill 实现**——机制原生是前提，见上文轮次 0 实证。
- **不做运行时动态挂载**——任何「skill 判断需要就挂上工具」的设计都要付前缀全量重建。
- **不动 team_orchestrate / council_convene 的现有归层**——两者各有决策注释，不在本计划范围。
`

/** D6 计划「**待验证假设**」加粗标签 + 编号列表真实片段。 */
const D6_MARKDOWN = `# D6 子系统数据可信度地基

**待验证假设**

1. **迁移采用「删除陈旧行、由 backfill 重建」而非「原地重写 id」，假设 backfill 能覆盖被删的 797 个文件。**
2. **GLOB 大小写敏感而 LIKE 对 ASCII 不敏感，假设这个收紧不会漏匹配。**
`

test('标题形态：## 反目标 + 列表 → 全部 anti-goal（D5 真实片段）', () => {
  const items = extractPlanConstraints(D5_MARKDOWN)
  assert.equal(items.length, 3)
  assert.ok(items.every(i => i.kind === 'anti-goal'))
  assert.ok(items[0]!.text.includes('不把 galaxy / starflow / scout 改成 skill 实现'))
  assert.equal(items[0]!.section, '反目标')
})

test('加粗标签形态：**待验证假设** + 编号列表 → assumption（D6 真实片段）', () => {
  const items = extractPlanConstraints(D6_MARKDOWN)
  assert.equal(items.length, 2)
  assert.ok(items.every(i => i.kind === 'assumption'))
  assert.ok(items[0]!.text.includes('迁移采用'))
})

test('同行形态：**非目标：** 不动 X → 1 条', () => {
  const items = extractPlanConstraints('**非目标：** 不动 schedule 的字段透传')
  assert.equal(items.length, 1)
  assert.equal(items[0]!.kind, 'anti-goal')
  assert.equal(items[0]!.text, '不动 schedule 的字段透传')
})

test('英文：## Non-Goals 与 ## Assumptions 各命中', () => {
  const anti = extractPlanConstraints('# P\n\n## Non-Goals\n\n- do not X')
  assert.equal(anti.length, 1)
  assert.equal(anti[0]!.kind, 'anti-goal')
  const assum = extractPlanConstraints('# P\n\n## Assumptions\n\n- Y holds')
  assert.equal(assum.length, 1)
  assert.equal(assum[0]!.kind, 'assumption')
})

test('反例：松散「假设」/「待验证假设在括号内」等全部不命中（真实语料）', () => {
  const cases = [
    '### 假设 1：「统一 read+search 单组始终更好」',
    '### 最要命的那个隐含前提',
    '### 无法复现的项（降级为待验证假设）',
    '### 反证结果：假设被打掉一半以上',
  ]
  for (const md of cases) {
    assert.deepEqual(extractPlanConstraints(md), [], `应返回 []：${md}`)
  }
})

test('终止边界：## 反目标 后 ## 改动面的列表项不得混入', () => {
  const md = '# P\n\n## 反目标\n\n- A\n\n## 改动面\n\n- B 不属于反目标\n'
  const items = extractPlanConstraints(md)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.text, 'A')
})

test('无章节 / 空串 / 只有标题没有列表 → 全部 []', () => {
  assert.deepEqual(extractPlanConstraints(''), [])
  assert.deepEqual(extractPlanConstraints('# 只有标题'), [])
  assert.deepEqual(extractPlanConstraints('普通散文没有章节'), [])
  assert.deepEqual(extractPlanConstraints('## 反目标\n'), []) // 只有标题没有列表
})

test('渲染超长：600 字符条目 → ≤400、带指针、断点落在句号', () => {
  const longText = 'A'.repeat(200) + '。' + 'B'.repeat(200) + '。' + 'C'.repeat(180)
  const items: PlanConstraint[] = [{ kind: 'assumption', text: longText, section: '待验证假设' }]
  const rendered = renderPlanConstraints(items, 'plan.md')
  assert.equal(rendered.length, 1)
  const out = rendered[0]!
  assert.ok(out.length <= 400, `产出 ${out.length} 应 ≤400`)
  assert.ok(out.includes('…（全文见 plan.md「待验证假设」）'))
  assert.ok(out.endsWith('）'))
  // 断点落在句号处：截断部分以句号结尾（不会把 B 段无标点硬切）
  assert.ok(out.endsWith('。…（全文见') === false) // 指针前是句号
  const beforePointer = out.slice(0, out.indexOf('…（全文见'))
  assert.ok(beforePointer.endsWith('。'))
})

test('渲染排序：anti-goal 全在 assumption 之前', () => {
  const items: PlanConstraint[] = [
    { kind: 'assumption', text: 'H2', section: '待验证假设' },
    { kind: 'anti-goal', text: 'G1', section: '反目标' },
    { kind: 'anti-goal', text: 'G2', section: '非目标' },
  ]
  const rendered = renderPlanConstraints(items)
  const firstAssumption = rendered.findIndex(r => r.startsWith('[计划待验证假设'))
  let lastAnti = -1
  rendered.forEach((r, i) => { if (r.startsWith('[计划反目标]')) lastAnti = i })
  assert.equal(rendered.length, 3)
  assert.ok(lastAnti < firstAssumption, `反目标 ${lastAnti} 应排在假设 ${firstAssumption} 前`)
})

// ── 来源解析链 ──

function makeTempPlan(): string {
  const dir = mkdtempSync(join(process.cwd(), '.rivet', 'tmp', 'plan-constraints-'))
  const plan = join(dir, 'plan.md')
  writeFileSync(plan, '# P\n\n## 反目标\n\n- 不扩展范围\n')
  return plan
}

test('优先级：markdown 与 planPath 不同 → 取 markdown 那份', () => {
  const plan = makeTempPlan()
  const md = '# P\n\n## 反目标\n\n- 来自 markdown\n'
  const res = resolvePlanConstraints(process.cwd(), { markdown: md, planPath: plan })
  assert.equal(res.length, 1)
  assert.ok(res[0]!.includes('来自 markdown'))
})

test('objective 识别：<绝对路径> 命中；路径不存在 → [] 不抛错', () => {
  const plan = makeTempPlan()
  const hit = resolvePlanConstraints(process.cwd(), { objective: `做 X 的落地实施 <${plan}>` })
  assert.equal(hit.length, 1)
  assert.ok(hit[0]!.includes('[计划反目标]'))
  const miss = resolvePlanConstraints(process.cwd(), { objective: `做 X <${join(process.cwd(), '.rivet', 'no-such-plan.md')}>` })
  assert.deepEqual(miss, [])
})

test('路径逃逸：objective 塞 ../../etc/passwd.md → 不读，返回 []', () => {
  const res = resolvePlanConstraints(process.cwd(), { objective: '落地 <../../etc/passwd.md>' })
  assert.deepEqual(res, [])
})

test('RIVET_PLAN_CONSTRAINTS=0 → 恒返回 []，测试后恢复', () => {
  process.env.RIVET_PLAN_CONSTRAINTS = '0'
  try {
    const md = '# P\n\n## 反目标\n\n- 不扩展范围\n'
    assert.deepEqual(resolvePlanConstraints(process.cwd(), { markdown: md }), [])
  } finally {
    delete process.env.RIVET_PLAN_CONSTRAINTS
  }
})

// ── coordinator 合并逻辑（D8 L2 兜底注入，fail-open）──

test('withPlanConstraints：只给计划级 → 工单含计划两条', () => {
  const cfg = { getPlanConstraints: () => ['[计划反目标] a', '[计划待验证假设·执行期先验证] b'] }
  const out = withPlanConstraints(undefined, 'x', cfg)
  assert.deepEqual(out, ['[计划反目标] a', '[计划待验证假设·执行期先验证] b'])
})

test('withPlanConstraints：request 在前，计划级在后', () => {
  const cfg = { getPlanConstraints: () => ['[计划反目标] a'] }
  const out = withPlanConstraints(['任务级约束'], 'x', cfg)
  assert.deepEqual(out, ['任务级约束', '[计划反目标] a'])
})

test('withPlanConstraints：getPlanConstraints 抛错 → 退化为只用 request（fail-open 核心断言）', () => {
  const cfg = { getPlanConstraints: () => { throw new Error('plan parse failed') } }
  const out = withPlanConstraints(['任务级约束'], 'x', cfg)
  assert.deepEqual(out, ['任务级约束'])
})

test('withPlanConstraints：getPlanConstraints 返回空 → 只用 request', () => {
  const cfg = { getPlanConstraints: () => [] }
  assert.deepEqual(withPlanConstraints(['任务级约束'], 'x', cfg), ['任务级约束'])
  assert.equal(withPlanConstraints(undefined, 'x', cfg), undefined)
})
