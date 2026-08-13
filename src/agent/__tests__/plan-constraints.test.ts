import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractPlanConstraints, renderPlanConstraints, resolvePlanConstraints, constraintsFromUnifiedPlan, findApprovedPlanConstraints, resetApprovedPlanCache, type PlanConstraint } from '../plan-constraints.js'
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

/** 隔离 cwd —— 断言「解析不到 → []」时必须用空仓库。解析链最后一环是回落到
 *  最近 APPROVED 计划（有意设计），拿真实仓库 cwd 会读到 .rivet/plans/ 里的
 *  真计划而返回非空，把「路径没读成」误判成「逃逸守卫失效」。 */
function makeIsolatedCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-constraints-cwd-'))
  mkdirSync(join(cwd, '.rivet', 'plans'), { recursive: true })
  return cwd
}

test('优先级：markdown 与 planPath 不同 → 取 markdown 那份', () => {
  const plan = makeTempPlan()
  const md = '# P\n\n## 反目标\n\n- 来自 markdown\n'
  const res = resolvePlanConstraints(process.cwd(), { markdown: md, planPath: plan })
  assert.equal(res.length, 1)
  assert.ok(res[0]!.includes('来自 markdown'))
})

test('objective 识别：<绝对路径> 命中；路径不存在 → [] 不抛错', () => {
  const cwd = makeIsolatedCwd()
  try {
    const plan = join(cwd, 'plan.md')
    writeFileSync(plan, '# P\n\n## 反目标\n\n- 不扩展范围\n')
    const hit = resolvePlanConstraints(cwd, { objective: `做 X 的落地实施 <${plan}>` })
    assert.equal(hit.length, 1)
    assert.ok(hit[0]!.includes('[计划反目标]'))
    const miss = resolvePlanConstraints(cwd, { objective: `做 X <${join(cwd, '.rivet', 'no-such-plan.md')}>` })
    assert.deepEqual(miss, [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('路径逃逸：objective 塞 ../../etc/passwd.md → 不读，返回 []', () => {
  const cwd = makeIsolatedCwd()
  try {
    assert.deepEqual(resolvePlanConstraints(cwd, { objective: '落地 <../../etc/passwd.md>' }), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
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

// ── 双源防冲突（D8 接线后）：request 已含计划级条目 → 兜底让位 ──

test('withPlanConstraints：request 已含 [计划反目标] → 跳过 getPlanConstraints（双源防冲突）', () => {
  let calls = 0
  const cfg = { getPlanConstraints: (objective: string) => { calls++; assert.equal(objective, 'x'); return ['[计划反目标] 兜底条目'] } }
  const out = withPlanConstraints(['[计划反目标] 议事会条目'], 'x', cfg)
  assert.deepEqual(out, ['[计划反目标] 议事会条目'])
  assert.equal(calls, 0, '已含计划级条目时兜底不应被调用')
})

test('withPlanConstraints：request 已含 [计划约束] → 同样跳过（不只反目标前缀）', () => {
  let calls = 0
  const cfg = { getPlanConstraints: () => { calls++; return [] } }
  const out = withPlanConstraints(['[计划约束] 暂缓项'], 'x', cfg)
  assert.deepEqual(out, ['[计划约束] 暂缓项'])
  assert.equal(calls, 0)
})

test('withPlanConstraints：request 只有任务级 → 仍追加计划级（任务级不触发跳过，兜底保留）', () => {
  let calls = 0
  const cfg = { getPlanConstraints: () => { calls++; return ['[计划反目标] 兜底条目'] } }
  const out = withPlanConstraints(['任务级约束'], 'x', cfg)
  assert.deepEqual(out, ['任务级约束', '[计划反目标] 兜底条目'])
  assert.equal(calls, 1)
})

// ── 真实语料形态回归 ──
//
// 上面那批用例喂的是手工裁剪过的干净片段，所以照不到下面三个形状——它们只在整份
// 计划文档里出现，而条目是**逐字**渲染进 worker 提示词的。

/** 复刻真实计划的排版：加粗标签段、非标签的加粗行、分割线、约束段。 */
const REAL_SHAPES = `# P

**非目标：**

- 不动 X

**技术栈：** TypeScript strict / ESM

---

## 机制

**约束**

- 通过环境变量 RIVET_TERSE=0 可关闭
`

test('分割线不是列表条目：--- / *** / - - - 均不产出条目', () => {
  for (const rule of ['---', '***', '___', '- - -', '* * *']) {
    const items = extractPlanConstraints(`## 反目标\n\n- 真条目\n\n${rule}\n`)
    assert.deepEqual(items.map(i => i.text), ['真条目'], `分割线 ${rule} 被当成了条目`)
  }
})

test('未命中标签名的加粗行：不产出残缺条目，且终止加粗列表', () => {
  const items = extractPlanConstraints(REAL_SHAPES)
  // `**技术栈：** …` 曾被 `*` 当成项目符号，吐出 `*技术栈：** TypeScript strict`
  assert.ok(!items.some(i => i.text.startsWith('*')), `残缺加粗行进了产出：${JSON.stringify(items.map(i => i.text))}`)
  // 且它之后的内容不再算在「非目标」名下
  assert.ok(!items.some(i => i.section === '非目标' && i.text.includes('TypeScript')))
})

test('**约束** 是 constraint 而非 anti-goal——不给实现约束打禁令前缀', () => {
  const items = extractPlanConstraints(REAL_SHAPES)
  const item = items.find(i => i.text.includes('RIVET_TERSE'))
  assert.ok(item, '约束段未被提取')
  assert.equal(item!.kind, 'constraint')
  assert.equal(item!.section, '约束')
  const rendered = renderPlanConstraints([item!])
  assert.ok(rendered[0]!.startsWith('[计划约束] '), `前缀错了：${rendered[0]}`)
})

test('渲染排序：anti-goal → constraint → assumption', () => {
  const items: PlanConstraint[] = [
    { kind: 'assumption', text: 'H', section: '待验证假设' },
    { kind: 'constraint', text: 'C', section: '约束' },
    { kind: 'anti-goal', text: 'G', section: '反目标' },
  ]
  const rendered = renderPlanConstraints(items)
  assert.deepEqual(rendered, ['[计划反目标] G', '[计划约束] C', '[计划待验证假设·执行期先验证] H'])
})

test('整份文档不变量：产出里没有分割线残渣、没有 markdown 残缺标记', () => {
  const items = extractPlanConstraints(REAL_SHAPES)
  assert.equal(items.length, 2, `产出条数意外：${JSON.stringify(items.map(i => i.text))}`)
  for (const item of items) {
    assert.ok(!/^[-*_\s]+$/.test(item.text), `纯符号条目：${JSON.stringify(item.text)}`)
    assert.ok(!item.text.startsWith('*'), `残缺加粗标记：${JSON.stringify(item.text)}`)
  }
})

// ── constraintsFromUnifiedPlan（starflow/team 的 planJson 契约 → 计划约束）──

test('constraintsFromUnifiedPlan：nonGoals → [计划反目标]，obligations 两 kind → [计划约束]', () => {
  const out = constraintsFromUnifiedPlan({
    nonGoals: ['不动 team 归层', '不做运行时动态挂载'],
    obligations: [
      { kind: 'deferred_decision', text: '暂缓项「备选方案B」——交付前需有着落' },
      { kind: 'high_risk_mitigation', text: '高危风险「缓存失效」的缓解承诺：加字节稳定测试' },
    ],
  })
  assert.deepEqual(out, [
    '[计划反目标] 不动 team 归层',
    '[计划反目标] 不做运行时动态挂载',
    '[计划约束] 暂缓项「备选方案B」——交付前需有着落',
    '[计划约束] 高危风险「缓存失效」的缓解承诺：加字节稳定测试',
  ])
})

test('constraintsFromUnifiedPlan：advisory_gate 跳过（走 verification 通道），空输入 → []', () => {
  assert.deepEqual(constraintsFromUnifiedPlan({
    nonGoals: [],
    obligations: [{ kind: 'advisory_gate', text: 'npx tsc --noEmit' }],
  }), [])
  assert.deepEqual(constraintsFromUnifiedPlan({}), [])
  assert.deepEqual(constraintsFromUnifiedPlan({ nonGoals: ['  '], obligations: [{ kind: 'deferred_decision', text: '  ' }] }), [])
})

// ── findApprovedPlanConstraints 缓存（TTL + 目录 mtime 双重失效，非计时断言）──

/** 建一个带 .rivet/plans 的隔离 cwd，写入一份 APPROVED 计划（含反目标条目）。 */
function makeApprovedPlanCwd(antiGoal: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-cache-cwd-'))
  mkdirSync(join(cwd, '.rivet', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.rivet', 'plans', 'p1.md'),
    `# P\n\n> **Status: APPROVED** — ${new Date().toISOString()}\n\n## 反目标\n\n- ${antiGoal}\n`)
  return cwd
}

test('缓存：TTL 内原地改写（目录 mtime 不变）→ 仍读到旧值；新增计划 → 立即失效', async () => {
  const cwd = makeApprovedPlanCwd('旧条目')
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
  try {
    // 目录 mtime 钉到固定值再首读——缓存基准即钉住值。不依赖文件系统的隐式
    // 目录 mtime 行为（WSL2 ext4 实测 in-place rewrite 也可能 bump 目录 mtime）。
    const plansDir = join(cwd, '.rivet', 'plans')
    const pinDirMtime = () => { const t = new Date(1_700_000_005_000); utimesSync(plansDir, t, t) }
    pinDirMtime()
    const first = findApprovedPlanConstraints(cwd)
    assert.deepEqual(first, ['[计划反目标] 旧条目'])

    // 原地改写同一文件后把目录 mtime 钉回原值 → TTL 内应命中缓存读旧值。
    writeFileSync(join(cwd, '.rivet', 'plans', 'p1.md'),
      `# P\n\n> **Status: APPROVED** — ${iso(1000)}\n\n## 反目标\n\n- 新条目（原地改写）\n`)
    pinDirMtime()
    const stale = findApprovedPlanConstraints(cwd)
    assert.deepEqual(stale, ['[计划反目标] 旧条目'], 'TTL 内原地改写应读到缓存旧值（目录 mtime 未变）')

    // 「最新计划」按文件 birthtime 排序——birthtime 不可写，且本机实测亚毫秒内
    // 连续创建会同值平局。等一个真实间隔再建 p2，保证它的 birthtime 严格晚于 p1。
    await new Promise(r => setTimeout(r, 20))
    // 新增计划文件（改变目录 mtime）→ 立即失效重读。
    writeFileSync(join(cwd, '.rivet', 'plans', 'p2.md'),
      `# P2\n\n> **Status: APPROVED** — ${iso(2000)}\n\n## 反目标\n\n- 新增计划的条目\n`)
    // 显式抬升目录 mtime：毫秒粒度下新增文件可能与缓存记录同刻，失效判定不触发
    const bumpedAt = new Date(Date.now() + 5000)
    utimesSync(join(cwd, '.rivet', 'plans'), bumpedAt, bumpedAt)
    const fresh = findApprovedPlanConstraints(cwd)
    assert.deepEqual(fresh, ['[计划反目标] 新增计划的条目'], '目录 mtime 变化应立即失效')

    // reset 后重新读取（缓存是模块级状态，测试必须能清）。
    resetApprovedPlanCache()
    const afterReset = findApprovedPlanConstraints(cwd)
    assert.deepEqual(afterReset, ['[计划反目标] 新增计划的条目'])
  } finally {
    resetApprovedPlanCache()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('缓存：目录不存在 → 「无计划」也缓存；目录出现（mtime 变化）→ 立即读到', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-cache-empty-'))
  try {
    assert.equal(findApprovedPlanConstraints(cwd), undefined)
    // 目录尚不存在时重复调用不重试（缓存了「无计划」——无法直接观测内部，
    // 以「目录出现后立即失效」验证 mtime 通道仍工作）。
    mkdirSync(join(cwd, '.rivet', 'plans'), { recursive: true })
    writeFileSync(join(cwd, '.rivet', 'plans', 'p1.md'),
      `# P\n\n> **Status: APPROVED** — ${new Date().toISOString()}\n\n## 反目标\n\n- 出现后的条目\n`)
    assert.deepEqual(findApprovedPlanConstraints(cwd), ['[计划反目标] 出现后的条目'])
  } finally {
    resetApprovedPlanCache()
    rmSync(cwd, { recursive: true, force: true })
  }
})
