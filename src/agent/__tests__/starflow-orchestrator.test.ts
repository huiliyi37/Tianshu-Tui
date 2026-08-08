import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveGalaxyDims,
  nextWaveOf,
  runStarflow,
  starflowStatePath,
  __setStarflowHeartbeatMs,
  type StarflowDeps,
  type StarflowInput,
  type StarflowSeat,
} from '../starflow-orchestrator.js'
import { formatTeamSummary } from '../../tools/team-orchestrate.js'
import type { Tool, ToolCallParams, ToolResult } from '../../tools/types.js'
import type { TeamOrchestrationOutcome } from '../orchestration-outcome.js'

// ── 假工具与结果工厂 ──────────────────────────────────────────────────────

type ExecuteFn = (params: ToolCallParams) => Promise<ToolResult>

function fakeTool(name: string, execute: ExecuteFn, calls: ToolCallParams[]): Tool {
  return {
    definition: { name, description: `fake ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(params) { calls.push(params); return execute(params) },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/** council 通过：产出密封契约 planJson（格式对齐 council-convene.ts 的嵌入块）。 */
function councilPassContent(planJson = '{"objective":"plan"}'): string {
  return ['# 议事记录', '', '裁决：全部接受', '', '```council-plan-json', planJson, '```', '', '✅ 计划已存入会话'].join('\n')
}

function teamPassContent(nextWave?: number): string {
  const lines = ['team standard：派发 2，波次 1，阻塞 0', '波次：', '  wave-0 [low] T1 — 静态预览', '', '<packet/>']
  if (nextWave !== undefined) {
    lines.push('', `集成完本波 diff 后运行下一波：再次调用 team_orchestrate 并传 fromWave: ${nextWave}。`)
  }
  return lines.join('\n')
}

function galaxyPassContent(): string {
  return ['🌌 星河集群执行报告 · 3/3 通过', '', '  impl 天梁: ✓ 完成', '', '聚合结论: 所有维度通过。'].join('\n')
}

function galaxyFailContent(): string {
  return [
    '🌌 星河集群执行报告 · 2/4 通过', '',
    '  frontend 文曲: ✗ 类型检查失败', '',
    '  review 瑶光: ✗ 发现阻塞问题', '',
    '  docs 天璇: ✓ 完成', '',
    '聚合结论: 2/4 个维度未通过，请检查上述摘要并在本回合内修复后再交付。',
  ].join('\n')
}

/** 反文案结果：content 一律是占位文案，门禁判定只应依赖 orchestration 字段。
 *  事实全在字段里——这是 Phase 1 的验收形状（文案已面目全非仍判定准确）。 */
function structuredTeam(over: Partial<TeamOrchestrationOutcome> = {}): ToolResult {
  return {
    content: '（文案已改，门禁不应依赖它）',
    orchestration: {
      kind: 'team', dispatched: 2, wave: 0, totalWaves: 1,
      workers: { total: 2, passed: 2 }, ...over,
    },
  }
}

function makeDeps(overrides: {
  council?: ExecuteFn
  team?: ExecuteFn
  galaxy?: ExecuteFn
  cwd?: string
}): { deps: StarflowDeps; calls: { council: ToolCallParams[]; team: ToolCallParams[]; galaxy: ToolCallParams[] }; cwd: string } {
  const cwd = overrides.cwd ?? mkdtempSync(join(tmpdir(), 'starflow-orch-'))
  const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
  const deps: StarflowDeps = {
    councilTool: fakeTool('council_convene', overrides.council ?? (async () => ({ content: councilPassContent() })), calls.council),
    teamTool: fakeTool('team_orchestrate', overrides.team ?? (async () => ({ content: teamPassContent() })), calls.team),
    galaxyTool: fakeTool('galaxy', overrides.galaxy ?? (async () => ({ content: galaxyPassContent() })), calls.galaxy),
    cwd,
    params: { input: {}, toolUseId: 'tu_starflow', cwd },
  }
  return { deps, calls, cwd }
}

const TWO_DRAFTS = [
  { id: 'impl', title: '实现核心逻辑', detail: '实现核心逻辑并过测试', files: ['src/core.ts'] },
  { id: 'review', title: '审查改动', detail: '审查核心逻辑的正确性', files: ['src/core.ts'] },
]

function baseInput(overrides?: Partial<StarflowInput>): StarflowInput {
  return { objective: '给项目加登录功能', draftItems: TWO_DRAFTS, ...overrides }
}

// ── 测试 ─────────────────────────────────────────────────────────────────

describe('STARFLOW_ORCHESTRATOR', () => {
  it('long phase emits a concrete phase heartbeat to the parent tool stream', async () => {
    __setStarflowHeartbeatMs(10)
    try {
      const outputs: string[] = []
      const { deps } = makeDeps({
        team: async () => {
          await new Promise(resolve => setTimeout(resolve, 35))
          return { content: teamPassContent() }
        },
      })
      deps.params.onOutput = chunk => outputs.push(chunk)
      await runStarflow(deps, baseInput())
      assert.ok(outputs.some(line => /星流 · team 阶段执行中/.test(line)), 'team phase heartbeat should be streamed')
    } finally {
      __setStarflowHeartbeatMs(10_000)
    }
  })

  it('全通过路径：council→team→galaxy→deliver，状态落盘且报告含交付清单', async () => {
    const { deps, calls, cwd } = makeDeps({})
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.council.length, 1)
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
    // council 收到草稿与 confirm:true；team 收到 council 产出的 planJson
    assert.equal(calls.council[0]!.input.confirm, true)
    assert.deepEqual(calls.council[0]!.input.draftItems, TWO_DRAFTS)
    assert.equal(calls.team[0]!.input.planJson, '{"objective":"plan"}')
    assert.equal(calls.team[0]!.input.autoAdvance, false, '逐波推进由星流外层状态机驱动——显式禁 team 自动推进')
    // galaxy 维度从 draftItems 派生
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ name: string; authority: string }>
    assert.deepEqual(dims.map(d => d.name), ['impl', 'review'])
    assert.deepEqual(dims.map(d => d.authority), ['tianliang', 'yaoguang'])
    // 状态文件：objective 哈希命名，phase=done
    const statePath = starflowStatePath(cwd, '给项目加登录功能')
    assert.ok(existsSync(statePath), '状态文件应落盘')
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(saved.phase, 'done')
    assert.equal(saved.phases.council.status, 'passed')
    assert.equal(saved.phases.team.status, 'passed')
    assert.equal(saved.phases.galaxy.status, 'passed')
    assert.equal(typeof saved.phases.council.elapsedMs, 'number')
    assert.equal(typeof saved.phases.team.elapsedMs, 'number')
    assert.ok(saved.phases.team.rawPath, 'phase output should have a durable fallback report')
    assert.match(readFileSync(saved.phases.team.rawPath, 'utf8'), /team standard/)
    assert.ok(saved.updatedAt > 0)
    assert.equal(typeof saved.runId, 'string')
    // M1：波级 checkpoint（波 0 通过时 saveState 一次）+ 四阶段各一次 = 5 次写入。
    // revision 语义从「每阶段一次」演进为「每阶段 + 每波次推进各一次」——波级
    // 记账让 blocked/resume 从已通过波次续跑，是 M1 的目标行为。
    assert.equal(saved.revision, 5, 'checkpoint 写入 = 4 阶段 + 1 波级推进')
    // 报告：交付检查清单 + deliver_task 提示
    assert.match(run.report, /交付检查清单/)
    assert.match(run.report, /deliver_task/)
    assert.match(run.report, /阶段 1 council 评审：✅/)
  })

  it('同一目标的并发运行被逻辑 lease 隔离，避免两个会话互相覆盖 checkpoint', async () => {
    const first = makeDeps({})
    let releaseTeam!: () => void
    let teamStarted!: () => void
    const started = new Promise<void>(resolve => { teamStarted = resolve })
    const hold = new Promise<void>(resolve => { releaseTeam = resolve })
    first.deps.teamTool = fakeTool('team_orchestrate', async () => {
      teamStarted()
      await hold
      return { content: teamPassContent() }
    }, first.calls.team)

    const firstPromise = runStarflow(first.deps, baseInput())
    await started

    const second = makeDeps({ cwd: first.cwd })
    const secondRun = await runStarflow(second.deps, baseInput())
    assert.equal(secondRun.state.phase, 'council')
    assert.match(secondRun.state.blockedReason ?? '', /another Starflow run/i)
    assert.equal(second.calls.council.length + second.calls.team.length + second.calls.galaxy.length, 0)

    releaseTeam()
    const firstRun = await firstPromise
    assert.equal(firstRun.state.phase, 'done')
  })

  it('阶段异常会保存可恢复的原始检查点，而不是只返回一行错误', async () => {
    const { deps, cwd } = makeDeps({
      council: async () => { throw new Error('provider first-byte timeout') },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    const rawPath = run.state.phases.council?.rawPath
    assert.ok(rawPath, 'phase error should have a durable raw report path')
    assert.match(readFileSync(rawPath!, 'utf8'), /provider first-byte timeout/)
    assert.ok(existsSync(starflowStatePath(cwd, '给项目加登录功能')))
  })

  it('新会话 resume 会发现旧会话状态，同时把后续 checkpoint 写入新命名空间', async () => {
    const first = makeDeps({})
    first.deps.params.sessionId = 'session-old'
    const firstRun = await runStarflow(first.deps, baseInput())
    assert.equal(firstRun.state.phase, 'done')
    assert.ok(existsSync(starflowStatePath(first.cwd, '给项目加登录功能', 'session-old')))

    const second = makeDeps({ cwd: first.cwd })
    second.deps.params.sessionId = 'session-new'
    const secondRun = await runStarflow(second.deps, baseInput({ resume: true }))
    assert.equal(secondRun.state.phase, 'done')
    assert.equal(second.calls.council.length, 0)
    assert.equal(second.calls.team.length, 0)
    assert.equal(second.calls.galaxy.length, 0)
    assert.ok(existsSync(starflowStatePath(first.cwd, '给项目加登录功能', 'session-new')))
  })

  it('council 否决（blocking challenge 未化解）→ blocked，附驳回理由，team/galaxy 不执行', async () => {
    const veto = ['# 议事记录', '', '## ⛔ 议事会否决（blocking challenge 未化解）', '- 华盖否决: 方案破坏向后兼容', '- 天权质疑: 缺少迁移路径', '', '计划未编译执行。'].join('\n')
    const { deps, calls } = makeDeps({ council: async () => ({ content: veto }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /华盖否决: 方案破坏向后兼容/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
    assert.match(run.report, /星流停止于 council 阶段/)
    assert.match(run.report, /下一步建议/)
  })

  it('council 禁用（COUNCIL=0，isError:false）→ blocked 视为评审未执行', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({ content: 'council_convene 已禁用（COUNCIL=0）——未派发任何席位', isError: false }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.match(run.state.blockedReason ?? '', /评审未执行/)
    assert.match(run.report, /COUNCIL=0/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
  })

  it('team 失败 → 回 council 复议一次（rounds:2）后重跑成功', async () => {
    let teamCalls = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        teamCalls++
        return teamCalls === 1
          ? { content: 'team_orchestrate 已拦截：未提供计划', isError: true }
          : { content: teamPassContent() }
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.council.length, 2, '初审 + 复议各一次')
    assert.equal(calls.council[1]!.input.rounds, 2, '复议强制反驳轮')
    assert.equal(calls.team.length, 2)
    assert.equal(run.state.teamRetries, 1)
    assert.ok(run.state.phases.team?.rawPath)
    const teamRaw = readFileSync(run.state.phases.team!.rawPath!, 'utf8')
    assert.match(teamRaw, /未提供计划/)
    assert.match(teamRaw, /team standard/)
    assert.match(run.report, /复议 1 次后通过/)
  })

  it('team 复议后再败 → blocked 停在 team 阶段', async () => {
    const { deps, calls } = makeDeps({
      team: async () => ({ content: 'team standard：派发 2，波次 1，阻塞 0\n\n⚠ 波次 0：全部 2 个 worker 失败——先集成/重试再前进；修复前不要派发 fromWave 1。' }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /全部失败/)
    assert.equal(calls.council.length, 2)
    assert.equal(calls.team.length, 2, '复议上限 1：team 最多跑两次')
    assert.equal(calls.galaxy.length, 0)
    assert.match(run.report, /星流停止于 team 阶段/)
    assert.match(run.report, /resume: true/)
  })

  // 门禁正则绑在 team-orchestrate.ts 的输出文案上，跨模块耦合：这里喂真实
  // formatTeamSummary 产出，改文案而漏改正则时这条会红，不会静默放行零派发。
  it('team 零派发 → blocked 停在 team 阶段', async () => {
    const zeroDispatched = formatTeamSummary({
      mode: 'standard', planned: [], tasks: [], waves: [], dispatched: 0, blocked: [], packet: '<packet/>',
    }, 0)
    const { deps, calls } = makeDeps({ team: async () => ({ content: zeroDispatched }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /未派发任何 worker/)
    assert.equal(calls.team.length, 2, '复议上限 1：team 最多跑两次')
    assert.equal(calls.galaxy.length, 0)
  })

  it('galaxy 聚合结论未通过 → blocked，附失败维度', async () => {
    const { deps, calls } = makeDeps({ galaxy: async () => ({ content: galaxyFailContent() }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'galaxy')
    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /2\/4 个维度未通过/)
    assert.match(run.state.blockedReason ?? '', /frontend 文曲/)
    assert.match(run.state.blockedReason ?? '', /review 瑶光/)
    assert.equal(calls.galaxy.length, 1)
    assert.match(run.report, /星流停止于 galaxy 阶段/)
  })

  it('resume:true 从状态文件续跑——已过阶段不重复执行', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'starflow-resume-'))
    let galaxyCalls = 0
    const galaxyScript: ExecuteFn = async () => {
      galaxyCalls++
      return galaxyCalls === 1 ? { content: galaxyFailContent() } : { content: galaxyPassContent() }
    }
    // 第一轮：galaxy 未通过 → blocked
    const first = makeDeps({ cwd, galaxy: galaxyScript })
    const run1 = await runStarflow(first.deps, baseInput())
    assert.equal(run1.state.phase, 'galaxy')
    assert.equal(first.calls.council.length, 1)
    assert.equal(first.calls.team.length, 1)

    // 第二轮：resume —— council/team 不重跑，直接重跑 galaxy
    const second = makeDeps({ cwd, galaxy: galaxyScript })
    const run2 = await runStarflow(second.deps, baseInput({ resume: true }))
    assert.equal(run2.state.phase, 'done')
    assert.equal(second.calls.council.length, 0, 'council 已过门禁不重跑')
    assert.equal(second.calls.team.length, 0, 'team 已过门禁不重跑')
    assert.equal(second.calls.galaxy.length, 1)
    assert.equal(run2.state.phases.council?.status, 'passed', '历史阶段记录保留')
    assert.equal(run2.state.phases.team?.status, 'passed')
  })

  it('无 galaxyDims 也无 draftItems → 跳过 galaxy 直达交付，报告注明跳过原因', async () => {
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ draftItems: undefined }))

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.galaxy.length, 0, '维度不足 2 个不调 galaxy（schema min 2）')
    assert.equal(run.state.phases.galaxy?.status, 'skipped')
    assert.match(run.report, /跳过/)
    assert.match(run.report, /无 draftItems 可派生维度/)
  })

  it('多波计划：按续波提示逐波推进直到末波', async () => {
    const teamWaves: number[] = []
    const { deps, calls } = makeDeps({
      team: async (params) => {
        const fromWave = Number(params.input.fromWave ?? 0)
        teamWaves.push(fromWave)
        return { content: teamPassContent(fromWave < 2 ? fromWave + 1 : undefined) }
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.deepEqual(teamWaves, [0, 1, 2], 'fromWave 0→1→2 逐波推进')
    assert.equal(calls.team.length, 3)
  })
})

// ── 结构化门禁验收（Phase 1）：文案面目全非、事实全在 orchestration 字段 ─────

describe('STARFLOW_TEAM_WAVE_RESUME', () => {
  const teamWaveFail = (teamWaves: number[]): ExecuteFn =>
    async (params: ToolCallParams) => {
      const fromWave = Number(params.input.fromWave ?? 0)
      teamWaves.push(fromWave)
      if (fromWave === 0) return { content: teamPassContent(1) }
      return { content: 'team standard：派发 2，波次 1，阻塞 0\n\n⚠ 波次 1：全部 2 个 worker 失败——修复前不要派发 fromWave 2。' }
    }

  it('M1: 波 0 通过后波 1 失败 → 复议后从波 1 续跑，不重跑波 0', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({ team: teamWaveFail(teamWaves) })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'team')
    assert.ok(run.state.blockedReason?.includes('全部失败'), run.state.blockedReason)
    assert.deepEqual(teamWaves, [0, 1, 1], '复议后从 completedTeamWaves=1 续跑，不重跑波 0')
  })

  it('M1: blocked 后 resume:true 从已通过波次续跑（council/波 0 不重跑）', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({ team: teamWaveFail(teamWaves) })
    await runStarflow(deps, baseInput())
    teamWaves.length = 0
    const resumed = await runStarflow(deps, baseInput({ resume: true }))
    assert.equal(resumed.state.phase, 'team')
    assert.deepEqual(teamWaves, [1], 'resume 后直接续波 1，council 与波 0 均不重跑')
  })

  it('M1: 全波通过时 completedTeamWaves 推进到末波（resume 无残留重跑）', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({
      team: async (params: ToolCallParams) => {
        const fromWave = Number(params.input.fromWave ?? 0)
        teamWaves.push(fromWave)
        return { content: teamPassContent(fromWave < 2 ? fromWave + 1 : undefined) }
      },
    })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.completedTeamWaves, 2, '末波 2 已记账')
    assert.deepEqual(teamWaves, [0, 1, 2], '三波正常推进')
  })
})

describe('STARFLOW_PREWARM_FACTS', () => {
  const draftWithFile = (cwd: string): StarflowInput =>
    baseInput({
      draftItems: [
        { id: 'impl', title: '实现核心逻辑', detail: '实现核心逻辑并过测试', files: ['src/core.ts'] },
        { id: 'review', title: '审查改动', detail: '审查核心逻辑的正确性', files: ['src/core.ts'] },
      ],
    })

  it('M3: council 等待期预取目标文件，派生维度 objective 注入摘要', async () => {
    const { deps, calls } = makeDeps({})
    mkdirSync(join(deps.cwd, 'src'), { recursive: true })
    writeFileSync(join(deps.cwd, 'src/core.ts'), 'export function core() { return 42 }\n', 'utf8')

    const run = await runStarflow(deps, draftWithFile(deps.cwd))

    assert.equal(run.state.phase, 'done')
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.match(dims[0]!.objective, /目标文件预取摘要/, '派生维度 objective 带预取事实块')
    assert.match(dims[0]!.objective, /src[/\\]core\.ts/, '预取块含文件路径')
    assert.match(dims[0]!.objective, /export function core/, '预取块含文件首行摘要')
  })

  it('M3: 显式 galaxyDims 不注入预取摘要（用户定义优先）', async () => {
    const { deps, calls } = makeDeps({})
    mkdirSync(join(deps.cwd, 'src'), { recursive: true })
    writeFileSync(join(deps.cwd, 'src/core.ts'), 'export function core() { return 42 }\n', 'utf8')

    await runStarflow(deps, {
      objective: '给项目加登录功能',
      draftItems: draftWithFile(deps.cwd).draftItems,
      galaxyDims: [
        { name: 'impl', objective: '用户指定的精确目标', authority: 'tianliang' },
        { name: 'review', objective: '用户指定的审查目标', authority: 'yaoguang' },
      ],
    })

    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.equal(dims[0]!.objective, '用户指定的精确目标', '显式维度 objective 原样透传')
    assert.equal(dims[1]!.objective, '用户指定的审查目标')
  })

  it('M3: 目标文件不存在时预取降级为空块，流程不受影响', async () => {
    const { deps, calls } = makeDeps({})
    // 不创建 src/core.ts——buildPrewarmValue 返回 undefined，无摘要
    const run = await runStarflow(deps, draftWithFile(deps.cwd))
    assert.equal(run.state.phase, 'done')
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.doesNotMatch(dims[0]!.objective, /目标文件预取摘要/, '无预取内容时不注入')
  })
})

describe('STARFLOW_TEAM_STRUCTURED_GATE', () => {
  it('结构化零派发（dispatched:0）→ blocked，reason 匹配「未派发任何 worker」', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ dispatched: 0 }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /未派发任何 worker/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化整波失败（workers 2/0）→ blocked，reason 匹配「全部失败」', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ workers: { total: 2, passed: 0 } }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /全部失败/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化波间硬门禁（waveGate.passed:false）→ blocked，reason 含失败命令', async () => {
    const { deps, calls } = makeDeps({
      team: async () => structuredTeam({ waveGate: { passed: false, failures: ['npx tsc --noEmit — 3 errors'] } }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /tsc/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化 review 驳回（reviewVerdict:rejected）→ blocked，reason 匹配「review gate 驳回」', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ reviewVerdict: 'rejected' }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /review gate 驳回/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化续波：wave/totalWaves 驱动 fromWave 推进，不靠文案', async () => {
    let wave = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        const current = wave++
        return structuredTeam({ wave: current, totalWaves: 2 })
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.deepEqual(calls.team.map(c => Number(c.input.fromWave)), [0, 1], 'fromWave 由 wave/totalWaves 推进')
    assert.ok(calls.team.every(c => c.input.autoAdvance === false), '每波都显式禁 autoAdvance，波间控制权留在星流')
    assert.equal(calls.galaxy.length, 1, '末波后进入 galaxy')
  })

  it('续波推进超过 10 波上限 → blocked，不无限循环', async () => {
    let wave = 0
    const { deps, calls } = makeDeps({
      team: async () => structuredTeam({ wave: wave++, totalWaves: 99 }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /波次推进超过上限（10）/)
    assert.equal(calls.team.length, 10, '上限 10 波即停，不进入第 11 波')
  })
})

describe('STARFLOW_NEXT_WAVE_OF', () => {
  // nextWaveOf 必须自带「整波失败不推波」，不能靠调用点先跑 teamGate 拦下。
  // 被它替代的正则路径自带这个条件：formatTeamSummary 在整波失败时用停止警告替换掉
  // 续波提示（team-orchestrate.ts:114），正则匹配不到即停。
  const outcome = (over: Partial<TeamOrchestrationOutcome> = {}): ToolResult => ({
    content: '（文案已改）',
    orchestration: {
      kind: 'team', dispatched: 2, wave: 0, totalWaves: 3,
      workers: { total: 2, passed: 2 }, ...over,
    },
  })

  it('整波失败 → undefined，不踩着失败的波次往前推', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 2, passed: 0 } })), undefined)
  })

  it('部分通过仍推进（与 formatTeamSummary 的 every(!passed) 判据一致）', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 2, passed: 1 } })), 1)
  })

  it('未派发（total 0）不算整波失败，由 teamGate 的 dispatched 判据管', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 0, passed: 0 } })), 1)
  })

  it('末波 → undefined', () => {
    assert.equal(nextWaveOf(outcome({ wave: 2, totalWaves: 3 })), undefined)
  })

  it('缺 orchestration → 回退续波提示正则', () => {
    assert.equal(nextWaveOf({ content: teamPassContent(2) }), 2)
    assert.equal(nextWaveOf({ content: teamPassContent() }), undefined)
  })
})

describe('STARFLOW_COUNCIL_STRUCTURED_GATE', () => {
  it('结构化禁用（disabled:true，文案面目全非）→ blocked，reason 匹配「评审未执行」', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'council', disabled: true },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /评审未执行/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化已执行（disabled:false，文案面目全非）→ council 通过继续流转', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'council', disabled: false },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.phases.council?.status, 'passed')
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
  })

  it('结构化席位全部失败（seats 5/0/5）→ blocked，reason 含席位数', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'council', disabled: false, seats: { total: 5, passed: 0, failed: 5 } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /席位全部失败/)
    assert.match(run.state.blockedReason ?? '', /5/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
  })

  it('结构化部分席位失败（passed>0）→ 不拦截，正常流转（有效评审）', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'council', disabled: false, seats: { total: 5, passed: 3, failed: 2 } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.phases.council?.status, 'passed')
    assert.equal(calls.team.length, 1)
  })
})

describe('STARFLOW_GALAXY_STRUCTURED_GATE', () => {
  it('结构化维度未通过（failed 非空）→ blocked，reason 附失败维度', async () => {
    const { deps, calls } = makeDeps({
      galaxy: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: {
          kind: 'galaxy',
          dimensions: { total: 4, passed: 2, failed: ['frontend 文曲', 'review 瑶光'] },
        },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'galaxy')
    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /2\/4 个维度未通过/)
    assert.match(run.state.blockedReason ?? '', /frontend 文曲/)
    assert.match(run.state.blockedReason ?? '', /review 瑶光/)
    assert.equal(calls.galaxy.length, 1)
  })

  it('failed 与 passed/total 分叉时 reason 取大者，不出现「0/N 未通过」的自相矛盾', async () => {
    // 两个判据数据源不同：passed/total 数 run.results，failed 数 targets（派发请求
    // 取不到结果也计入）。分叉时若仍用 total-passed 报数，会输出「0/3 个维度未通过
    // （frontend 文曲）」。
    const { deps } = makeDeps({
      galaxy: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'galaxy', dimensions: { total: 3, passed: 3, failed: ['frontend 文曲'] } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /1\/3 个维度未通过/)
    assert.doesNotMatch(run.state.blockedReason ?? '', /0\/3/)
  })

  it('结构化全部通过（failed 空，passed === total）→ galaxy 通过进入交付', async () => {
    const { deps, calls } = makeDeps({
      galaxy: async () => ({
        content: '（文案已改，门禁不应依赖它）',
        orchestration: { kind: 'galaxy', dimensions: { total: 3, passed: 3, failed: [] } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.phases.galaxy?.status, 'passed')
    assert.equal(calls.galaxy.length, 1)
  })
})

describe('STARFLOW_DERIVE_GALAXY_DIMS', () => {
  it('authority 映射：review/verify→yaoguang，docs/research→tianxuan，其余→tianliang', () => {
    const dims = deriveGalaxyDims([
      { id: 'verify-api', title: '验证接口', detail: 'd1' },
      { id: 'docs', title: '写文档', detail: 'd2' },
      { id: 'research', title: '调研方案', detail: 'd3' },
      { id: 'impl', title: '实现', detail: 'd4', files: ['a.ts'] },
    ])
    assert.deepEqual(dims.map(d => d.authority), ['yaoguang', 'tianxuan', 'tianxuan', 'tianliang'])
    assert.deepEqual(dims.map(d => d.objective), ['d1', 'd2', 'd3', 'd4'])
    assert.deepEqual(dims[3]!.files, ['a.ts'], 'files 映射为维度 scope')
  })

  it('id 去重且最多 5 个维度', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `t${i % 6}`, title: `任务${i}`, detail: `d${i}` }))
    const dims = deriveGalaxyDims(items)
    assert.equal(dims.length, 5)
    assert.equal(new Set(dims.map(d => d.name)).size, 5)
  })
})

// ── 复盘 A-D 落地（docs/tasks/2026-08-03-starflow-iteration-plan.md）────────

describe('STARFLOW_ITERATION_A_SEATS', () => {
  it('缺省不传 seats 键；显式 seats 透传到首轮与复议轮', async () => {
    const plain = makeDeps({})
    await runStarflow(plain.deps, baseInput())
    assert.equal('seats' in plain.calls.council[0]!.input, false, '缺省不传 seats 键（行为不回归）')

    const seats: StarflowSeat[] = [{ authority: 'tianquan' }, { authority: 'yaoguang', tierHint: 'strong' }]
    let teamCalls = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        teamCalls++
        return teamCalls === 1
          ? { content: 'team_orchestrate 已拦截：未提供计划', isError: true }
          : { content: teamPassContent() }
      },
    })
    const run = await runStarflow(deps, baseInput({ seats }))
    assert.equal(run.state.phase, 'done')
    assert.deepEqual(calls.council[0]!.input.seats, seats, '首轮透传 seats')
    assert.deepEqual(calls.council[1]!.input.seats, seats, '复议轮透传 seats')
    assert.equal(calls.council[1]!.input.rounds, 2)
  })
})

describe('STARFLOW_ITERATION_B_INCREMENTAL_REVIEW', () => {
  it('previousVerdict=passed 的条目在 councilInput 渲染中带沿用语，全量条目仍在', async () => {
    const carried = { ...TWO_DRAFTS[0]!, previousVerdict: 'passed' as const }
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ draftItems: [carried, TWO_DRAFTS[1]!] }))
    assert.equal(run.state.phase, 'done')
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /沿用前轮通过结论/)
    assert.match(objective, /impl/, '沿用语点名携带条目 id')
    assert.deepEqual(calls.council[0]!.input.draftItems, [carried, TWO_DRAFTS[1]!], '全量条目仍出现在渲染里（信息不丢）')
  })

  it('无 previousVerdict 时不带沿用语', async () => {
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput())
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /沿用前轮通过结论/)
  })

  it('守卫：revision 与 previousVerdict 同现视为已修订——不沿用', async () => {
    // 调用方 bump revision 但忘清 previousVerdict（工具描述未强约束前的忠实行为）：
    // 宁重审不放过——fail-dangerous 修正（2026-08-03 审查）。
    const revised = { ...TWO_DRAFTS[0]!, previousVerdict: 'passed' as const, revision: 2 }
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput({ draftItems: [revised, TWO_DRAFTS[1]!] }))
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /沿用前轮通过结论/)
    assert.deepEqual(calls.council[0]!.input.draftItems, [revised, TWO_DRAFTS[1]!], '条目仍全量在渲染里')
  })
})

describe('STARFLOW_ITERATION_C_BASELINE_PRECHECK', () => {
  function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'starflow-git-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'core.ts'), '// v1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
    return dir
  }

  it('git 仓库：councilInput.objective 含目标文件 status 命中行与必答句', async () => {
    const dir = makeGitRepo()
    writeFileSync(join(dir, 'src', 'core.ts'), '// v2\n') // 制造 dirty 状态
    const { deps, calls } = makeDeps({ cwd: dir })
    const run = await runStarflow(deps, baseInput({ draftItems: [{ ...TWO_DRAFTS[0]!, files: ['src/core.ts'] }] }))
    assert.equal(run.state.phase, 'done')
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /基线预检/)
    assert.match(objective, /src\/core\.ts/, 'status 命中行原样列出')
    assert.match(objective, /第一轮评审必须先核对草稿断言与上述工作树\/提交现状的差异/)
  })

  it('git 仓库：目标文件最近提交历史也进 precheck', async () => {
    const dir = makeGitRepo()
    const { deps, calls } = makeDeps({ cwd: dir })
    await runStarflow(deps, baseInput({ draftItems: [{ ...TWO_DRAFTS[0]!, files: ['src/core.ts'] }] }))
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /基线预检/)
    assert.match(objective, /init/, '最近提交行含 init 提交')
  })

  it('非 git 目录：点火不炸，无预检块', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starflow-nogit-'))
    const { deps, calls } = makeDeps({ cwd: dir })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'done')
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /基线预检/)
  })

  it('draftItems 无 files：不注入预检块（无目标文件可查）', async () => {
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput({ draftItems: [{ id: 'x', title: 't', detail: 'd' }] }))
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /基线预检/)
  })

  it('autoReview:false 跳过 Galaxy 追加审查波次', async () => {
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ autoReview: false }))

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.galaxy.length, 1)
    assert.equal(calls.galaxy[0]!.input.autoReview, false)
  })
})
