import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCouncilConveneTool, DEFAULT_COUNCIL_SEATS, type CouncilConveneCoordinator } from '../council-convene.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { deriveStableWorkOrderId } from '../../agent/coordinator.js'
import type { WorkerResult } from '../../agent/work-order.js'
import { validateUnifiedPlan, type UnifiedPlan } from '../../agent/unified-plan.js'
import type { ToolCallParams } from '../types.js'

function extractPlanJson(content: string): UnifiedPlan | undefined {
  const m = content.match(/```council-plan-json\n([\s\S]*?)\n```/)
  return m ? (JSON.parse(m[1]!) as UnifiedPlan) : undefined
}

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
    assert.match(res.uiContent!, /议事会 · \d+ 席 \d+ 轮/)
    assert.notEqual(res.uiContent, res.content)
  })

  it('per-call seats 带 provider+model → 扇出请求携带 modelOverride（异构议事会）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({
      objective: 'x',
      seats: [
        { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
        { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
        { authority: 'tianxuan' },
      ],
    }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.find(r => r.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    assert.deepEqual(reqs.find(r => r.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
    assert.equal(reqs.find(r => r.authority === 'tianxuan')?.modelOverride, undefined)
  })

  it('config defaultSeats（无 per-call seats）→ 用配置席位并带 modelOverride', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
    ])
    await tool.execute(paramsWith({ objective: 'x' }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), ['tianquan', 'tianfu'])
    assert.deepEqual(reqs.find(r => r.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    assert.deepEqual(reqs.find(r => r.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
  })

  it('重复 authority（per-call）→ isError 且零派发', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'x',
      seats: [
        { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
        { authority: 'tianquan', provider: 'glm', model: 'glm-4.6' },
      ],
    }))
    assert.equal(res.isError, true)
    assert.match(res.content, /重复/)
    assert.equal(calls.requests.length, 0, '重复席位必须在派发前拦截')
  })

  it('重复 authority（config defaultSeats）→ isError', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianfu', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
    ])
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, true)
    assert.equal(calls.requests.length, 0)
  })

  it('per-call seats 优先于 config defaultSeats', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
    ])
    await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'wenqu' }] }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), ['wenqu'])
    assert.equal(reqs[0]!.modelOverride, undefined)
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

  it('rounds=2 + 冲突 → 触发 round2（2 次 delegateBatch）', async () => {
    const calls = { requests: [] as DelegationRequest[][] }
    let batchCalls = 0
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        calls.requests.push(requests)
        batchCalls++
        const results = requests.map(req => {
          if (req.parentTurnId.endsWith('-r2')) {
            return {
              ...workerResultFor(req),
              artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: 'r2', rebuttals: [] }) }],
            }
          }
          // round1：两席对同 id 给出不同 detail → 产生冲突
          const detail = req.authority === 'tianquan' ? 'X' : 'Y'
          return {
            ...workerResultFor(req),
            artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: `${req.authority}-s`, additions: [{ id: 'NEW', title: 't', detail }], risks: [], challenges: [], alternatives: [] }) }],
          }
        })
        return {
          status: 'completed',
          results,
          packet: '',
          workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'test-model' })),
        }
      },
      getSessionId: () => 'sess-1',
    }
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'split loop.ts',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
      rounds: 2,
    }))
    assert.equal(res.isError, false)
    assert.equal(batchCalls, 2, 'rounds=2 + 冲突 → 两次扇出')
    // round2 请求带 -r2 后缀
    const r2Reqs = calls.requests[1]!
    assert.ok(r2Reqs.every(r => r.parentTurnId.endsWith('-r2')), 'round2 parentTurnId 带 -r2')
  })

  it('rounds 透传：默认（不传）→ 单轮（1 次 delegateBatch）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({
      objective: 'split loop.ts',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
    }))
    assert.equal(calls.requests.length, 1, '默认单轮')
  })

  it('W-C7：有任务 → content 内嵌可执行 council-plan-json 块且通过 validateUnifiedPlan', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'split loop.ts',
      draftItems: [{ id: 'T1', title: 'Split', detail: 'do it' }],
    }))
    const planJson = extractPlanJson(res.content)
    assert.ok(planJson, 'content 应内嵌 council-plan-json 块')
    const v = validateUnifiedPlan(planJson)
    assert.equal(v.valid, true, JSON.stringify(v))
    // uiContent 紧凑摘要不应被 planJson 污染
    assert.doesNotMatch(res.uiContent!, /council-plan-json/)
  })

  it('W-C7：席位 addition 的 files 透传进 planJson 任务节点', async () => {
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        const results = requests.map(req => ({
          ...workerResultFor(req),
          artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({
            authority: req.authority, summary: 's',
            additions: req.authority === 'tianquan' ? [{ id: 'A1', title: 'a', detail: 'd', files: ['src/loop.ts', 'src/api.ts'] }] : [],
            risks: [], challenges: [], alternatives: [],
          }) }],
        }))
        return { status: 'completed', results, packet: '', workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'm' })) }
      },
      getSessionId: () => 'sess-1',
    }
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'x',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
    }))
    const planJson = extractPlanJson(res.content)!
    const a1 = planJson.tasks.find(t => t.id === 'A1')
    assert.ok(a1, 'addition A1 应进入 planJson')
    assert.deepEqual(a1!.files, ['src/loop.ts', 'src/api.ts'])
  })

  it('W-C7：无任务（空 mergedItems）→ content 不附加 planJson 块', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'tianquan' }] }))
    assert.equal(extractPlanJson(res.content), undefined, '无任务时不应内嵌 planJson')
  })
})
