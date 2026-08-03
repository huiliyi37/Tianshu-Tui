import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStarflowTool } from '../starflow.js'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'

// ── 假子工具（只计数，零真实派发） ─────────────────────────────────────────

function fakeTool(name: string, execute: (params: ToolCallParams) => Promise<ToolResult>, calls: ToolCallParams[]): Tool {
  return {
    definition: { name, description: `fake ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(params) { calls.push(params); return execute(params) },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

const COUNCIL_PASS = ['# 议事记录', '', '```council-plan-json', '{"objective":"plan"}', '```'].join('\n')
const TEAM_PASS = 'team standard：派发 2，波次 1，阻塞 0'
const GALAXY_PASS = '🌌 星河集群执行报告 · 2/2 通过\n\n聚合结论: 所有维度通过。'

function makeTool(overrides?: { councilResult?: ToolResult }) {
  const cwd = mkdtempSync(join(tmpdir(), 'starflow-tool-'))
  const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
  const tool = createStarflowTool({
    councilTool: fakeTool('council_convene', async () => overrides?.councilResult ?? { content: COUNCIL_PASS }, calls.council),
    teamTool: fakeTool('team_orchestrate', async () => ({ content: TEAM_PASS }), calls.team),
    galaxyTool: fakeTool('galaxy', async () => ({ content: GALAXY_PASS }), calls.galaxy),
    cwd,
  })
  return { tool, calls, cwd }
}

const DRAFTS = [
  { id: 'impl', title: '实现', detail: '实现登录逻辑', files: ['src/auth.ts'] },
  { id: 'review', title: '审查', detail: '审查登录逻辑' },
]

describe('STARFLOW_TOOL', () => {
  it('confirm 缺省 → 只展示执行方案，三个子工具零调用', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_1',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS },
    })

    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length, 0, 'proposal 阶段不调 council')
    assert.equal(calls.team.length, 0, 'proposal 阶段不调 team')
    assert.equal(calls.galaxy.length, 0, 'proposal 阶段不调 galaxy')
    assert.match(result.content, /星流执行方案/)
    assert.match(result.content, /council 评审/)
    assert.match(result.content, /team 波次/)
    assert.match(result.content, /galaxy 攻坚 — 2 个维度/)
    assert.match(result.content, /confirm: true/)
    assert.match(result.uiContent ?? '', /星流方案/)
  })

  it('confirm:false 显式 → 同样零执行', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_2',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: false },
    })
    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length + calls.team.length + calls.galaxy.length, 0)
  })

  it('confirm:true → 触发状态机执行，全过后输出交付清单', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_3',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.council.length, 1)
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
    assert.match(result.content, /星流执行报告/)
    assert.match(result.content, /交付检查清单/)
    assert.match(result.uiContent ?? '', /全阶段通过/)
  })

  it('confirm:true 且 council 被禁用 → 返回 blocked 报告且 isError', async () => {
    const { tool, calls } = makeTool({
      councilResult: { content: 'council_convene 已禁用（COUNCIL=0）——未派发任何席位', isError: false },
    })
    const result = await tool.execute({
      toolUseId: 'tu_4',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, true, 'blocked 必须向工具管线报失败信号')
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
    assert.match(result.content, /星流停止于 council 阶段/)
    assert.match(result.uiContent ?? '', /受阻于 council/)
  })

  it('参数错误 → format_error（objective 缺失 / galaxyDims 仅 1 个）', async () => {
    const { tool } = makeTool()
    const missing = await tool.execute({ toolUseId: 'tu_5', cwd: '/repo', input: {} })
    assert.equal(missing.isError, true)
    assert.equal(missing.errorKind, 'format_error')
    const oneDim = await tool.execute({
      toolUseId: 'tu_6',
      cwd: '/repo',
      input: { objective: 'x', galaxyDims: [{ name: 'a', objective: 'b' }] },
    })
    assert.equal(oneDim.isError, true)
    assert.equal(oneDim.errorKind, 'format_error')
  })

  it('timeoutMs 覆盖三阶段串行预算（大于任一单工具的 10 分钟）', () => {
    const { tool } = makeTool()
    const budget = tool.timeoutMs?.({ input: { objective: 'x' }, toolUseId: 'tu_7', cwd: '/repo' })
    assert.ok(typeof budget === 'number' && budget > 600_000, `预算应超过单工具 600s 上限，实际 ${budget}`)
  })
})
