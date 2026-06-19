import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCouncilConveneTool, DEFAULT_COUNCIL_SEATS, type CouncilConveneCoordinator } from '../council-convene.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { deriveStableWorkOrderId } from '../../agent/coordinator.js'
import type { WorkerResult } from '../../agent/work-order.js'
import type { ToolCallParams } from '../types.js'

function workerResultFor(req: DelegationRequest): WorkerResult {
  const contrib = JSON.stringify({ authority: req.authority, summary: `${req.authority}-said`, additions: [], risks: [], challenges: [], alternatives: [] })
  return {
    workOrderId: deriveStableWorkOrderId(req.parentTurnId) ?? 'wo_unstable',
    status: 'passed',
    summary: `${req.authority} done`,
    findings: [],
    artifacts: [{ kind: 'note', title: 'seat-contribution', content: contrib }],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }
}

function makeCoordinator(extra?: Partial<CouncilConveneCoordinator>): {
  coordinator: CouncilConveneCoordinator
  calls: { requests: DelegationRequest[][] }
} {
  const calls = { requests: [] as DelegationRequest[][] }
  const coordinator: CouncilConveneCoordinator = {
    delegateBatch: async (requests): Promise<CoordinatorRun> => {
      calls.requests.push(requests)
      const results = requests.map(workerResultFor)
      return {
        status: 'completed',
        results,
        packet: '',
        // workerModels 回填真实模型信息 → runCouncil 注入 contribution.modelUsed
        workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'test-model' })),
      }
    },
    getSessionId: () => 'sess-1',
    ...extra,
  }
  return { coordinator, calls }
}

function paramsWith(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 't1', cwd: process.cwd() }
}

describe('council_convene 工具', () => {
  const savedEnv = process.env.COUNCIL
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.COUNCIL
    else process.env.COUNCIL = savedEnv
  })

  it('definition 名为 council_convene，objective 必填', () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    assert.equal(tool.definition.name, 'council_convene')
    assert.deepEqual(tool.definition.input_schema?.required, ['objective'])
  })

  it('非法输入（缺 objective）→ isError', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({}))
    assert.equal(res.isError, true)
    assert.equal(calls.requests.length, 0)
  })

  it('缺省席位 → 扇出 tianquan/tianfu/tianxuan，全部 plan/council_expert', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'split loop.ts' }))
    assert.equal(res.isError, false)
    assert.equal(calls.requests.length, 1)
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), DEFAULT_COUNCIL_SEATS.map(s => s.authority))
    for (const r of reqs) {
      assert.equal(r.kind, 'plan')
      assert.equal(r.profile, 'council_expert')
    }
    assert.match(res.content, /议事会计划/)
    // uiContent: 工具卡紧凑摘要（≤4 行），全文 markdown 仍在 content。
    assert.ok(res.uiContent, 'council_convene 应返回 uiContent 紧凑摘要')
    assert.ok(res.uiContent!.split('\n').length <= 4)
    assert.match(res.uiContent!, /议事会 · \d+ 席单轮/)
    assert.notEqual(res.uiContent, res.content)
  })

  it('解耦：扇出请求绝不携带写/执行语义（kind 全 plan，无 patch/verify）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'tianquan' }] }))
    const reqs = calls.requests[0]!
    assert.ok(reqs.every(r => r.kind === 'plan'), '议事会只出意见，绝不派执行')
  })

  it('COUNCIL=0 → 零派发，isEnabled=false', async () => {
    process.env.COUNCIL = '0'
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    assert.equal(tool.isEnabled(), false)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(calls.requests.length, 0, 'kill switch 必须零派发')
    assert.match(res.content, /disabled/)
  })

  it('遥测 + 路由 shadow 旁路落盘（不影响返回）', async () => {
    const sessions: unknown[] = []
    const shadows: unknown[] = []
    const { coordinator } = makeCoordinator({
      recordCouncilSession: e => sessions.push(e),
      recordRoutingShadow: e => shadows.push(e),
    })
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, false)
    assert.equal(sessions.length, 1, '应记一条会诊遥测')
    assert.equal(shadows.length, DEFAULT_COUNCIL_SEATS.length, '每席记一条路由 shadow')
  })

  it('遥测 store 抛错不影响交付', async () => {
    const { coordinator } = makeCoordinator({
      recordCouncilSession: () => { throw new Error('db down') },
    })
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, false)
    assert.match(res.content, /议事会计划/)
  })
})
