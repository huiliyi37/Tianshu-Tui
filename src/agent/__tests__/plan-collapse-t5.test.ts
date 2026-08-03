/**
 * T5 归因与回归：planJson 多任务计划进 team 被坍缩成单任务单波
 * （docs/analysis/2026-07-29-team-mode-e2e-repro-and-gaps.md §三 Run 4 / §四 #5）。
 *
 * 三个嫌疑点逐一钉死：
 *  1. plan-store sessionId 桥接 —— 无坍缩（pin）
 *  2. UnifiedPlan → TeamTask 转换 + groupTeamTasks 波次分组 —— 无坍缩（pin）
 *  3. decomposeObjective 在 files 缺席时退化成单任务 monolith —— 真根因（复现 + 修复回归）
 *
 * 附带同族修复：team-grouping 的 source+test 绑定只认 .ts/.tsx，
 * .mjs/.js 测试文件永远绑不回源文件分片。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { storePlan, consumePlan, clearPlan } from '../plan-store.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks } from '../unified-plan.js'
import { groupTeamTasks } from '../team-grouping.js'
import { decomposeObjective } from '../task-planner.js'
import type { TeamTask } from '../team-plan.js'

/** e2e 实测的 7 任务 2 波形状：1 个 explore scout + 6 个 patcher 分片。 */
function sevenTaskPlanJson(): string {
  const patchers = ['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => ({
    id: `T${i + 2}`,
    title: `edit module ${m}`,
    objective: `Modify src/mod${m}/impl.ts`,
    profile: 'patcher',
    kind: 'patch_proposal',
    files: [`src/mod${m}/impl.ts`],
    dependsOn: ['T1'],
    riskTier: 'low',
  }))
  return JSON.stringify({
    version: 1,
    objective: 'seven task two wave plan',
    tasks: [
      { id: 'T1', title: 'explore', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      ...patchers,
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
}

/** e2e Run 4 的真实任务形状：编号清单 + 显式新建文件路径，files 参数缺席
 *  （新建文件类任务的文件还不存在，模型不传 files 是合理行为）。 */
const E2E_OBJECTIVE = `在 toolkit2/ 目录下创建一个零依赖工具库，三个相互独立的模块，每个模块一个源文件加一个测试文件，纯 ESM（.mjs），测试用 node:test + node:assert/strict，不引入 npm 依赖，不改动仓库其他文件。

1. toolkit2/slug.mjs + toolkit2/slug.test.mjs —— slugify(text)：转小写、连续空白折叠为单个连字符、移除非字母数字连字符字符、去首尾连字符。
2. toolkit2/clamp.mjs + toolkit2/clamp.test.mjs —— clamp(n, min, max) 与 lerp(a, b, t)。
3. toolkit2/dedent.mjs + toolkit2/dedent.test.mjs —— dedent(text)：移除所有非空行的公共前导空格，保留相对缩进。`

describe('T5 嫌疑点 1（排除）：plan-store sessionId 桥接不坍缩', () => {
  it('storePlan → consumePlan 同 sessionId 逐字节还原 7 任务计划', () => {
    const sessionId = 't5-store-roundtrip'
    clearPlan(sessionId)
    const json = sevenTaskPlanJson()
    storePlan(json, sessionId)

    const consumed = consumePlan(sessionId)
    assert.equal(consumed, json)
    const plan = deserializeUnifiedPlan(consumed!)
    assert.equal(plan?.tasks.length, 7)
  })

  it('不同 sessionId 取不到计划（fail-loud：team 侧会硬拦报错而非静默降级）', () => {
    const sessionId = 't5-store-mismatch'
    clearPlan(sessionId)
    clearPlan(`${sessionId}-other`)
    storePlan(sevenTaskPlanJson(), sessionId)

    assert.equal(consumePlan(`${sessionId}-other`), null)
    clearPlan(sessionId)
  })
})

describe('T5 嫌疑点 2（排除）：UnifiedPlan → TeamTask → 波次分组不坍缩', () => {
  it('7 任务计划经反序列化 + 转换 1:1 保留', () => {
    const plan = deserializeUnifiedPlan(sevenTaskPlanJson())
    assert.ok(plan)
    const tasks = unifiedPlanToTeamTasks(plan!)
    assert.equal(tasks.length, 7)
    assert.deepEqual(tasks.map(t => t.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'])
  })

  it('groupTeamTasks 分波后任务全量覆盖：不丢、不合并（非 source+test 对）', () => {
    const plan = deserializeUnifiedPlan(sevenTaskPlanJson())
    const tasks = unifiedPlanToTeamTasks(plan!)
    const waves = groupTeamTasks(tasks)

    const dispatched = waves.flatMap(w => w.taskIds)
    assert.equal(new Set(dispatched).size, 7, '7 个任务必须全部进入某个波次')
    // 依赖结构（6 patcher 依赖 1 scout）+ 写工每波上限 3 → 至少 3 波。
    assert.ok(waves.length >= 3, `期望多波，实际 ${waves.length} 波`)
  })
})

describe('T5 真根因（修复回归）：decomposeObjective files 缺席时的 monolith 坍缩', () => {
  it('编号清单 + 显式文件路径、无 files 参数 → 按清单分片而非单任务 monolith', () => {
    const graph = decomposeObjective({ objective: E2E_OBJECTIVE })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')

    // 修复前：1 个 patcher、files:[]（e2e 观察到的坍缩形状）。
    // 修复后：3 个编号项各成一片，scope 来自条目中提到的文件路径。
    assert.equal(patchers.length, 3, `期望 3 个分片，实际 ${patchers.length}`)
    for (const p of patchers) {
      assert.ok(p.files.length > 0, `分片 ${p.id} 的 files 不得为空（Scope Health leaked 的来源）`)
    }
    const slugShard = patchers.find(p => p.files.includes('toolkit2/slug.mjs'))
    assert.ok(slugShard, 'slug 分片必须携带条目里点名的文件')
    assert.ok(slugShard!.files.includes('toolkit2/slug.test.mjs'), '同条目的测试文件绑进同一分片')
  })

  it('无编号清单但正文点名文件路径 → 提取为 scope 走模块分组', () => {
    const graph = decomposeObjective({
      objective: '同步修改 src/tui/render.ts 与 src/api/client.ts 的超时语义',
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.equal(patchers.length, 2, '两个模块应切成两个正交分片')
    const allFiles = patchers.flatMap(p => p.files)
    assert.ok(allFiles.includes('src/tui/render.ts'))
    assert.ok(allFiles.includes('src/api/client.ts'))
  })

  it('正文无任何文件线索时保持既有单分片行为（不误伤）', () => {
    const graph = decomposeObjective({ objective: 'Add feature X' })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.equal(patchers.length, 1)
  })

  it('显式 files 参数优先：不受正文编号清单影响（既有行为不变）', () => {
    const graph = decomposeObjective({
      objective: E2E_OBJECTIVE,
      files: ['src/foo/x.ts'],
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.equal(patchers.length, 1, '调用方显式 scope 赢过正文推断')
    assert.deepEqual(patchers[0]!.files, ['src/foo/x.ts'])
  })
})

describe('T5 同族：source+test 绑定应扩展名无关（.mjs 也要绑）', () => {
  function patcher(id: string, files: string[]): TeamTask {
    return {
      id,
      title: id,
      objective: `write ${files.join(', ')}`,
      files,
      profile: 'patcher',
      kind: 'patch_proposal',
      verification: [],
      dependsOn: [],
      riskTier: 'low',
      touchSet: files,
    }
  }

  it('.ts source+test 对绑成一个任务（既有行为基线）', () => {
    const waves = groupTeamTasks([
      patcher('S', ['src/agent/foo.ts']),
      patcher('T', ['src/agent/foo.test.ts']),
    ])
    const dispatched = waves.flatMap(w => w.taskIds)
    assert.equal(dispatched.length, 1, '.ts 对应绑定为单任务')
  })

  it('.mjs source+test 对同样绑成一个任务', () => {
    const waves = groupTeamTasks([
      patcher('S', ['toolkit2/slug.mjs']),
      patcher('T', ['toolkit2/slug.test.mjs']),
    ])
    const dispatched = waves.flatMap(w => w.taskIds)
    assert.equal(dispatched.length, 1, '.mjs 对也应绑定，避免测试分片与源分片竞速')
  })

  // ── 中文自由文本 + 裸文件名的分解 RED ──────────────────────────
  // 真实日志场景：LLM 传入自由文本 objective，无 files 参数，无编号列表，
  // 仅靠"创建 X.ts""扩展 Y.ts"动词+裸文件名表达范围。修复前退化为
  // monolith + files:[]（worker 空 scope → 写工未产出改动）。

  it('decomposeObjective: 中文动词+裸文件名 → 提取为 scope，不退化 monolith', () => {
    const graph = decomposeObjective({
      objective: '桌面端通知音效：创建 sound.ts Web Audio 引擎，扩展 persist.ts 持久化，接入通知系统',
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    // 两个独立裸文件 → 两个正交分片（比 monolith 好）
    assert.equal(patchers.length, 2)
    const allFiles = patchers.flatMap(p => p.files)
    assert.ok(allFiles.includes('sound.ts'), '应提取"创建 sound.ts"')
    assert.ok(allFiles.includes('persist.ts'), '应提取"扩展 persist.ts"')
    for (const p of patchers) {
      assert.ok(p.files.length > 0, `分片 ${p.id} 的 files 不得为空——修复前 monolith + files:[] 导致 worker 空 scope`)
    }
  })

  it('decomposeObjective: 仅有裸文件名时 files 非空', () => {
    const graph = decomposeObjective({
      objective: '重构 handler.ts 使用 async/await',
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.ok(patchers[0]!.files.includes('handler.ts'))
  })

  // ── moduleKey 3 段分组回归 ──────────────────────────────────────
  // 审查发现（0df98574 post-commit）：./ 前缀 + 3 段目录 → 坍缩回 2 段；
  // desktop/src/* 场景无测试锁定，修复目标原样失效。两例同族一锅端。

  it('moduleKey: desktop/src 下四个子模块切为四个正交分片', () => {
    const graph = decomposeObjective({
      objective: '修复多处 UI 文案与状态逻辑',
      files: [
        'desktop/src/surfaces/settings/OtherPage.tsx',
        'desktop/src/locales/en/settings.json',
        'desktop/src/locales/zh-CN/settings.json',
        'desktop/src/state/queries.ts',
        'desktop/src/components/HomeWelcome.tsx',
      ],
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    // surfaces、locales、state、components — 四个子模块各成一分片
    assert.equal(patchers.length, 4)
    const labels = patchers.map(p => p.files)
    assert.ok(labels.some(fs => fs.includes('desktop/src/surfaces/settings/OtherPage.tsx')))
    assert.ok(labels.some(fs => fs.includes('desktop/src/locales/en/settings.json')))
    assert.ok(labels.some(fs => fs.includes('desktop/src/state/queries.ts')))
    assert.ok(labels.some(fs => fs.includes('desktop/src/components/HomeWelcome.tsx')))
  })

  it('moduleKey: ./ 前缀不影响分组——与无前缀一致', () => {
    const graph = decomposeObjective({
      objective: '修复 UI 文案',
      files: [
        './desktop/src/surfaces/ProjectSidebar.tsx',
        './desktop/src/state/mission-projector.ts',
      ],
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.equal(patchers.length, 2, './ 前缀不应导致坍缩')
  })
})
